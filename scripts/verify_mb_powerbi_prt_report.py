"""
Cross-check VW_MB_POWERBI_PRT_REPORT (Load Dataset key: mb_powerbi_prt_report)
against what the dashboard shows when you pick “All rows” (server DATASET_HARD_CAP).

Runs SQL Server aggregates directly using repo-root .env (same DB_* as other scripts).

The ERP connector loads:
  SELECT TOP (@cap) * FROM dbo.VW_MB_POWERBI_PRT_REPORT … ORDER BY [date] DESC
when MB_POWERBI_PRT_REPORT_FILTER_DATE_COLUMN is set; otherwise TOP has **no ORDER BY**
(nondeterministic slice).

Compare:
  - Total rows in the view vs cap (usually 20_000)
  - SUM / AVG of PrtQty on the **same TOP slice** the UI uses
  - Warns that SUM(AVG) of PurInvoiceNo, Para2Index, ItemMRP line totals are not business KPIs

Usage:
  python scripts/verify_mb_powerbi_prt_report.py
  python scripts/verify_mb_powerbi_prt_report.py --limit 20000
  python scripts/verify_mb_powerbi_prt_report.py --table dbo.VW_MB_POWERBI_PRT_REPORT

Requires: pyodbc (pip install pyodbc), ODBC Driver 17/18 for SQL Server
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from decimal import Decimal

try:
    import pyodbc
except ImportError as exc:
    print("Install pyodbc: pip install pyodbc", file=sys.stderr)
    raise SystemExit(2) from exc

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
        raise ValueError(f"Use schema.object e.g. dbo.VW_MB_POWERBI_PRT_REPORT — got {full!r}")
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
    ap = argparse.ArgumentParser(description="Verify PRT report slice vs DB")
    ap.add_argument("--env", default=env_path, help="Path to .env")
    ap.add_argument("--table", default="dbo.VW_MB_POWERBI_PRT_REPORT", help="Qualified table/view name")
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="TOP N (default: DATASET_HARD_CAP from .env or 20000)",
    )
    args = ap.parse_args()

    env = load_env(args.env)
    hard_cap = int(env.get("DATASET_HARD_CAP", "20000") or "20000")
    limit = args.limit if args.limit is not None else hard_cap

    prefix = "MB_POWERBI_PRT_REPORT"
    date_col = (env.get(f"{prefix}_FILTER_DATE_COLUMN") or "").strip()
    schema, obj = parse_schema_table(args.table)
    fq = f"[{schema}].[{obj}]"

    conn = connect_from_env(env)
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) AS c FROM {fq}")
    total_rows = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total_rows:,}\nAPI 'All rows' cap (effective TOP): {limit:,}")

    order_sql = ""
    if date_col:
        dc = sanitize_ident(date_col)
        order_sql = f" ORDER BY CAST([{dc}] AS date) DESC"
        print(f"ORDER BY (from env): CAST([{dc}] AS date) DESC")
    else:
        print("MB_POWERBI_PRT_REPORT_FILTER_DATE_COLUMN unset → API adds NO ORDER BY (slice order undefined).")
        print("Script matches that by omitting ORDER BY in the TOP subquery.")

    # Aggregate expressions safe on varchar invoice numbers (digits only in practice)
    inner_top = f"SELECT TOP ({limit}) * FROM {fq}{order_sql}"
    agg_sql = f"""
WITH slice AS (
  {inner_top}
)
SELECT
  COUNT_BIG(*) AS row_cnt,
  SUM(CAST([PrtQty] AS BIGINT)) AS sum_prtqty,
  AVG(CAST([PrtQty] AS FLOAT)) AS avg_prtqty,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvoiceNo] AS nvarchar(100)))), ',', ''), ' ', ''))
           IS NOT NULL
           THEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvoiceNo] AS nvarchar(100)))), ',', ''), ' ', ''))
           ELSE 0 END) AS sum_pur_invoice_no_as_number,
  AVG(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvoiceNo] AS nvarchar(100)))), ',', ''), ' ', ''))
           IS NOT NULL
           THEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvoiceNo] AS nvarchar(100)))), ',', ''), ' ', ''))
           ELSE NULL END) AS avg_pur_invoice_no_as_number,
  SUM(CAST(ISNULL([Para2Index], 0) AS BIGINT)) AS sum_para2_index,
  AVG(CAST(ISNULL([Para2Index], 0) AS FLOAT)) AS avg_para2_index,
  SUM(CAST(ISNULL([ItemMRP], 0) AS BIGINT)) AS sum_item_mrp_raw,
  AVG(CAST(ISNULL([ItemMRP], 0) AS FLOAT)) AS avg_item_mrp_raw,
  SUM(CASE WHEN TRY_CONVERT(float, REPLACE(REPLACE(RTRIM(LTRIM(CAST([PurInvoiceNo] AS nvarchar(100)))), ',', ''), ' ', '')) IS NOT NULL THEN 1 ELSE 0 END) AS invoice_numeric_cells
FROM slice;
"""

    cur.execute(agg_sql)
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    agg = dict(zip(cols, row))

    print("\n=== Aggregates on TOP slice (matches capped rows returned to UI) ===")
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

    rpc = num(agg.get("sum_prtqty"))
    rc = int(agg.get("row_cnt") or 0)
    print("\n=== Sanity vs dashboard KPI strip ===")
    print(f"  If dashboard shows {rc:,} rows and Σ PrtQty ≈ {rpc:,.6g}, SQL agrees.")
    print(
        "  PurInvoiceNo / Para2Index / ItemMRP sums in the UI are NOT meaningful "
        "(document refs / attributes / list-price lines)."
    )

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
