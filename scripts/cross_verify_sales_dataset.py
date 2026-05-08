"""
Cross-verify sales dataset totals vs GET /api/dataset/sales semantics:

  SELECT TOP (@limit) * FROM <SALES_VIEW>
  WHERE CAST([date_col] AS DATE) BETWEEN @from AND @to
  ORDER BY [date_col] DESC   (when SALES_FILTER_DATE_COLUMN is set in .env — same as API)

Compares:
  - Full-window aggregates (every row in the date range on the server)
  - TOP-N slice aggregates (matches dashboard row cap — what KPI sums over when you load 500 rows)
  - Optional: positive-lines-only heuristic (similar to dashboard with "Include returns" OFF)

Usage:
  python scripts/cross_verify_sales_dataset.py 2025-11-01 2026-05-06
  python scripts/cross_verify_sales_dataset.py 2025-11-01 2026-05-06 500

Requires: pyodbc, repo root .env with DB_* and optionally SALES_VIEW, SALES_FILTER_DATE_COLUMN.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from decimal import Decimal

try:
    import pyodbc
except Exception as exc:
    print(f"pyodbc import failed: {exc}")
    sys.exit(2)

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def load_env(path: str) -> dict:
    env = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def connect_from_env(env: dict):
    server = env.get("DB_SERVER")
    port = env.get("DB_PORT", "1433")
    db = env.get("DB_NAME")
    user = env.get("DB_USER")
    pwd = env.get("DB_PASSWORD")
    encrypt = (env.get("DB_ENCRYPT", "false") or "false").lower() in ("1", "true", "yes")

    if not all([server, db, user, pwd]):
        raise RuntimeError("Missing DB_* values in .env")

    drivers = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ]
    last_err = None
    for d in drivers:
        conn_str = (
            f"DRIVER={{{d}}};"
            f"SERVER={server},{port};"
            f"DATABASE={db};"
            f"UID={user};"
            f"PWD={pwd};"
            f"Encrypt={'yes' if encrypt else 'no'};"
            "TrustServerCertificate=yes;"
        )
        try:
            conn = pyodbc.connect(conn_str, timeout=60)
            print(f"Connected using driver: {d}")
            return conn
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Unable to connect. Last error: {last_err}")


def sanitize_ident(name: str) -> str:
    n = (name or "").strip()
    if not IDENT_RE.match(n):
        raise ValueError(f"Invalid SQL identifier (use letters, digits, underscore only): {name!r}")
    return n


def parse_table_parts(full: str) -> tuple[str, str]:
    """
    dbo.VwAISalesData -> ('dbo', 'VwAISalesData')
    """
    s = (full or "").strip()
    if "." not in s:
        raise ValueError(f"SALES_VIEW must be schema-qualified, e.g. dbo.VwAISalesData — got {full!r}")
    schema, obj = s.split(".", 1)
    return sanitize_ident(schema.strip()), sanitize_ident(obj.strip())


def num(x) -> float:
    if x is None:
        return 0.0
    if isinstance(x, Decimal):
        return float(x)
    return float(x)


def fetchone_dict(cur):
    row = cur.fetchone()
    if not row:
        return {}
    return {d[0]: getattr(row, d[0]) for d in cur.description}


def main() -> int:
    parser = argparse.ArgumentParser(description="Cross-verify sales view: full range vs TOP N (API parity).")
    parser.add_argument("from_date", help="Start date yyyy-mm-dd")
    parser.add_argument("to_date", help="End date yyyy-mm-dd")
    parser.add_argument("limit", nargs="?", type=int, default=500, help="TOP N rows (dashboard default 500)")
    parser.add_argument(
        "--positive-only",
        action="store_true",
        help="Also print aggregates excluding negative qty/net lines (dashboard 'Include returns' OFF heuristic).",
    )
    args = parser.parse_args()

    root = os.path.dirname(os.path.dirname(__file__))
    env = load_env(os.path.join(root, ".env"))

    table_full = env.get("SALES_VIEW") or "dbo.VwAISalesData"
    date_col_raw = env.get("SALES_FILTER_DATE_COLUMN") or "InvoiceDt"
    date_col = sanitize_ident(date_col_raw)
    schema, obj = parse_table_parts(table_full)
    fq = f"[{schema}].[{obj}]"

    lim = max(1, min(int(args.limit), 999999))

    fr, to = args.from_date.strip(), args.to_date.strip()
    print("\n=== CONFIG (from .env) ===")
    print(f"Sales object     : {fq}")
    print(f"Date column      : [{date_col}]")
    print(f"BETWEEN          : {fr} .. {to}")
    print(f"TOP (limit)      : {lim}")

    conn = connect_from_env(env)
    cur = conn.cursor()

    # --- Full window: row mix + totals
    sql_full = f"""
    SELECT
      COUNT(1) AS TotalRows,
      SUM(CASE WHEN ISNULL([Quantity], 0) < 0 THEN 1 ELSE 0 END) AS RowsNegQty,
      SUM(CASE WHEN ISNULL([Quantity], 0) > 0 THEN 1 ELSE 0 END) AS RowsPosQty,
      SUM(CASE WHEN ISNULL([Quantity], 0) = 0 THEN 1 ELSE 0 END) AS RowsZeroQty,
      SUM(CASE WHEN ISNULL([SaleNetAmount], 0) < 0 THEN 1 ELSE 0 END) AS RowsNegNet,
      SUM(CASE WHEN ISNULL([SaleNetAmount], 0) > 0 THEN 1 ELSE 0 END) AS RowsPosNet,
      SUM(ISNULL([Quantity], 0)) AS SumQty,
      SUM(ISNULL([SaleNetAmount], 0)) AS SumSaleNetAmount,
      SUM(ISNULL([SaleAmountBeforeTax], 0)) AS SumBeforeTax,
      SUM(ISNULL([TaxAmount], 0)) AS SumTaxAmount
    FROM {fq}
    WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
    """

    sql_top = f"""
    SELECT
      COUNT(1) AS TotalRows,
      SUM(ISNULL([Quantity], 0)) AS SumQty,
      SUM(ISNULL([SaleNetAmount], 0)) AS SumSaleNetAmount,
      SUM(ISNULL([SaleAmountBeforeTax], 0)) AS SumBeforeTax,
      SUM(ISNULL([TaxAmount], 0)) AS SumTaxAmount
    FROM (
      SELECT TOP ({lim}) [Quantity], [SaleNetAmount], [SaleAmountBeforeTax], [TaxAmount]
      FROM {fq}
      WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
      ORDER BY CAST([{date_col}] AS date) DESC
    ) AS sliced
    """

    print("\n=== FULL DATE WINDOW (every row server-side) ===")
    cur.execute(sql_full, (fr, to))
    r_full = fetchone_dict(cur)
    if not r_full:
        print("No rows.")
    else:
        rc = int(r_full.get("TotalRows") or 0)
        print(f"TotalRows          : {rc:,}")
        print(f"Rows (qty < 0)     : {int(r_full.get('RowsNegQty') or 0):,}")
        print(f"Rows (qty > 0)     : {int(r_full.get('RowsPosQty') or 0):,}")
        print(f"Rows (qty = 0)     : {int(r_full.get('RowsZeroQty') or 0):,}")
        print(f"Rows (net < 0)     : {int(r_full.get('RowsNegNet') or 0):,}")
        print(f"Rows (net > 0)     : {int(r_full.get('RowsPosNet') or 0):,}")
        print(f"SUM(Quantity)      : {num(r_full.get('SumQty')):,.6g}")
        print(f"SUM(SaleNetAmount) : {num(r_full.get('SumSaleNetAmount')):,.2f}")
        print(f"Lakhs Σ net (~÷1e5): {num(r_full.get('SumSaleNetAmount')) / 100_000:.2f} L")

    print("\n=== TOP N (API / dashboard KPI slice — ORDER BY date DESC, then SUM that set) ===")
    cur.execute(sql_top, (fr, to))
    r_top = fetchone_dict(cur)
    if not r_top:
        print("No rows.")
    else:
        print(f"Slice row count    : {int(r_top.get('TotalRows') or 0):,}")
        print(f"SUM(Quantity)      : {num(r_top.get('SumQty')):,.6g}")
        print(f"SUM(SaleNetAmount) : {num(r_top.get('SumSaleNetAmount')):,.2f}")
        print(f"Lakhs Σ net (~÷1e5): {num(r_top.get('SumSaleNetAmount')) / 100_000:.2f} L")

    if args.positive_only and r_full:
        sql_pos = f"""
        SELECT
          COUNT(1) AS TotalRows,
          SUM(ISNULL([Quantity], 0)) AS SumQty,
          SUM(ISNULL([SaleNetAmount], 0)) AS SumSaleNetAmount
        FROM {fq}
        WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
          AND NOT (ISNULL([Quantity], 0) < 0 OR ISNULL([SaleNetAmount], 0) < 0)
        """
        print("\n=== POSITIVE-LINES WINDOW (qty >= 0 AND net >= 0 — like ‘Include returns’ OFF) ===")
        cur.execute(sql_pos, (fr, to))
        r_pos = fetchone_dict(cur)
        print(f"TotalRows          : {int(r_pos.get('TotalRows') or 0):,}")
        print(f"SUM(Quantity)      : {num(r_pos.get('SumQty')):,.6g}")
        print(f"SUM(SaleNetAmount) : {num(r_pos.get('SumSaleNetAmount')):,.2f}")
        print(f"Lakhs Σ net (~÷1e5): {num(r_pos.get('SumSaleNetAmount')) / 100_000:.2f} L")

    print("\n=== READOUT ===")
    print(
        "If the dashboard KPIs disagree with FULL WINDOW, you're only summing TOP N preview rows "
        "(or client-side excludes returns unless ‘Include returns’ is on)."
    )
    if not env.get("SALES_FILTER_DATE_COLUMN"):
        print(
            "Note: SALES_FILTER_DATE_COLUMN is unset in .env — this script defaulted to InvoiceDt. "
            "Set it to match the API or column errors / wrong windows will occur."
        )

    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        raise SystemExit(2)
