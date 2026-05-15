"""
Cross-check dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT (Load Dataset key: mb_powerbi_supplier_pur_report).

Replicates the API pattern: SELECT TOP (@cap) * … [ORDER BY date DESC] and aggregates on that slice
so you can compare Σ PurQty / row count with the dashboard.

Notes:
  - Full view COUNT(*) may exceed DATASET_HARD_CAP; the UI shows min(total, cap) rows.
  - Σ PurInvNo / Para2Index / PurChallanNo are identifiers or attributes — not rupee KPIs.
  - When MB_POWERBI_SUPPLIER_PUR_REPORT_FILTER_DATE_COLUMN is unset, TOP has no ORDER BY (undefined order).

Usage:
  python scripts/verify_mb_powerbi_supplier_pur_report.py
  python scripts/verify_mb_powerbi_supplier_pur_report.py --limit 20000

Requires: pyodbc, ODBC Driver 17/18 for SQL Server, repo-root .env with DB_*.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from decimal import Decimal

try:
    import pyodbc
except ImportError:
    print("Install pyodbc: pip install pyodbc", file=sys.stderr)
    raise SystemExit(2) from None

IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def load_env(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def connect_from_env(env: dict[str, str]):
    server = env.get("DB_SERVER")
    port = env.get("DB_PORT", "1433")
    db = env.get("DB_NAME")
    user = env.get("DB_USER")
    pwd = env.get("DB_PASSWORD")
    encrypt = (env.get("DB_ENCRYPT", "false") or "false").lower() in ("1", "true", "yes")
    if not all([server, db, user, pwd]):
        raise RuntimeError("Missing DB_* in .env")

    drivers = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ]
    last = None
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
            conn = pyodbc.connect(conn_str, timeout=120)
            print(f"Connected via {d}")
            return conn
        except Exception as e:
            last = e
    raise RuntimeError(f"Connect failed: {last}") from last


def sanitize_ident(name: str) -> str:
    n = (name or "").strip()
    if not IDENT_RE.match(n):
        raise ValueError(f"Invalid identifier: {name!r}")
    return n


def parse_schema_table(full: str) -> tuple[str, str]:
    s = (full or "").strip()
    if "." not in s:
        raise ValueError(f"Use schema.object — got {full!r}")
    a, b = s.split(".", 1)
    return sanitize_ident(a.strip()), sanitize_ident(b.strip())


def num(x) -> float | None:
    if x is None:
        return None
    if isinstance(x, Decimal):
        return float(x)
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    env_path = os.path.join(root, ".env")
    ap = argparse.ArgumentParser(description="Verify supplier PUR report slice vs SQL")
    ap.add_argument("--env", default=env_path, help="Path to .env")
    ap.add_argument("--table", default="dbo.VW_MB_POWERBI_SUPPLIER_PUR_REPORT", help="Qualified view name")
    ap.add_argument("--limit", type=int, default=None, help="TOP N (default: DATASET_HARD_CAP)")
    args = ap.parse_args()

    env = load_env(args.env)
    hard_cap = int(env.get("DATASET_HARD_CAP", "20000") or "20000")
    limit = args.limit if args.limit is not None else hard_cap

    prefix = "MB_POWERBI_SUPPLIER_PUR_REPORT"
    date_col = (env.get(f"{prefix}_FILTER_DATE_COLUMN") or "").strip()
    schema, obj = parse_schema_table(args.table)
    fq = f"[{schema}].[{obj}]"

    conn = connect_from_env(env)
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) AS c FROM {fq}")
    total_rows = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total_rows:,}\nTOP limit (API cap): {limit:,}")

    order_sql = ""
    if date_col:
        dc = sanitize_ident(date_col)
        order_sql = f" ORDER BY CAST([{dc}] AS date) DESC"
        print(f"ORDER BY: CAST([{dc}] AS date) DESC  ({prefix}_FILTER_DATE_COLUMN)")
    else:
        print(
            f"{prefix}_FILTER_DATE_COLUMN unset → API uses no ORDER BY on dataset dump; "
            "slice order is nondeterministic."
        )

    inner_top = f"SELECT TOP ({limit}) * FROM {fq}{order_sql}"
    # Numeric parse for doc# columns (for comparison to bogus UI sums only)
    agg_sql = f"""
WITH slice AS (
  {inner_top}
)
SELECT
  COUNT_BIG(*) AS row_cnt,
  SUM(CAST(ISNULL([PurQty], 0) AS BIGINT)) AS sum_pur_qty,
  AVG(CAST(ISNULL([PurQty], 0) AS FLOAT)) AS avg_pur_qty,
  SUM(CASE WHEN [PurQty] IS NOT NULL THEN 1 ELSE 0 END) AS pur_qty_cells,
  SUM(CAST(ISNULL([Para2Index], 0) AS BIGINT)) AS sum_para2_index,
  AVG(CAST(ISNULL([Para2Index], 0) AS FLOAT)) AS avg_para2_index,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvNo] AS nvarchar(100)))), ',', ''), ' ', '')) IS NOT NULL
           THEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvNo] AS nvarchar(100)))), ',', ''), ' ', '')) ELSE 0 END) AS sum_pur_inv_no_as_number,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurChallanNo] AS nvarchar(100)))), ',', ''), ' ', '')) IS NOT NULL
           THEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurChallanNo] AS nvarchar(100)))), ',', ''), ' ', '')) ELSE 0 END) AS sum_pur_challan_as_number,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvNo] AS nvarchar(100)))), ',', ''), ' ', '')) IS NOT NULL THEN 1 ELSE 0 END) AS purinv_numeric_count,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurChallanNo] AS nvarchar(100)))), ',', ''), ' ', '')) IS NOT NULL THEN 1 ELSE 0 END) AS challan_numeric_count
FROM slice;
"""

    cur.execute(agg_sql)
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    agg = dict(zip(cols, row))

    print("\n=== Aggregates on capped slice (same row set style as GET /api/dataset/...) ===")
    for k in cols:
        v = agg[k]
        if v is None:
            continue
        if isinstance(v, Decimal):
            v = float(v)
        if isinstance(v, float):
            print(f"  {k}: {v:,.6g}")
        else:
            print(f"  {k}: {v:,}")

    rc = int(agg.get("row_cnt") or 0)
    spq = num(agg.get("sum_pur_qty"))
    print("\n=== Match to dashboard ===")
    print(f"  Row count in slice: {rc:,}  (dashboard should show ≤ {limit:,} rows).")
    print(f"  Σ PurQty on slice: {spq:,.6g} — compare to KPI ‘sum’ for PurQty.")
    print(
        "  Different counts on PurInvNo / PurChallanNo KPIs vs row total = empty/non-numeric cells; "
        "those columns are still not valid money totals."
    )
    print(
        "\n  Interpretation: Para2Index / invoice / challan sums are NOT financial totals — "
        "use PurQty, PurchasePrice, or amount columns for valuation when present."
    )

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
