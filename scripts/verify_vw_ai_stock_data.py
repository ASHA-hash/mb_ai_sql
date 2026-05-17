"""
Cross-check dbo.VwAIStockData (Load Dataset key: stock).

One row = one ItemId at one BranchId with StockQty. The dashboard must NOT imply
SUM(StockQty) on TOP 500 rows equals company-wide inventory.

Usage:
  python scripts/verify_vw_ai_stock_data.py
  python scripts/verify_vw_ai_stock_data.py --limit 500

Requires: pyodbc, repo-root .env with DB_*.
Optional: STOCK_VIEW=dbo.VwAIStockData
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

    last = None
    for d in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server", "SQL Server"):
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


def resolve_stock_view(env: dict[str, str]) -> str:
    raw = (env.get("STOCK_VIEW") or "").strip() or "dbo.VwAIStockData"
    if "." not in raw:
        raw = f"dbo.{raw}"
    schema, obj = raw.split(".", 1)
    return f"[{sanitize_ident(schema)}].[{sanitize_ident(obj)}]"


def num(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, Decimal):
        return float(v)
    return float(v)


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description="Verify VwAIStockData slice vs dashboard")
    ap.add_argument("--env", default=os.path.join(root, ".env"))
    ap.add_argument("--limit", type=int, default=500)
    args = ap.parse_args()

    lim = max(1, int(args.limit))
    fq = resolve_stock_view(load_env(args.env))
    print(f"View: {fq}")

    conn = connect_from_env(load_env(args.env))
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) FROM {fq}")
    total = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total:,}\nTOP slice: {lim:,}")

    sql_full = f"""
    SELECT
      SUM(ISNULL([StockQty], 0)) AS SumQty,
      COUNT(DISTINCT [ItemId]) AS DistinctItems,
      COUNT(DISTINCT [BranchId]) AS DistinctBranches
    FROM {fq}
    """

    sql_top = f"""
    SELECT
      COUNT(1) AS Rows,
      SUM(ISNULL([StockQty], 0)) AS SumQty,
      COUNT(DISTINCT [ItemId]) AS DistinctItems,
      COUNT(DISTINCT [BranchId]) AS DistinctBranches,
      SUM(CASE WHEN ISNULL([StockQty], 0) > 0 THEN 1 ELSE 0 END) AS RowsPosQty
    FROM (SELECT TOP ({lim}) * FROM {fq}) s
    """

    print("\n=== Full inventory (all rows in view) ===")
    cur.execute(sql_full)
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    f = dict(zip(cols, row))
    print(f"SUM(StockQty)        : {num(f['SumQty']):,.2f}")
    print(f"Distinct ItemId      : {int(f['DistinctItems'] or 0):,}")
    print(f"Distinct BranchId    : {int(f['DistinctBranches'] or 0):,}")

    print(f"\n=== TOP {lim} rows (dashboard default load) ===")
    cur.execute(sql_top)
    row2 = cur.fetchone()
    cols2 = [d[0] for d in cur.description]
    t = dict(zip(cols2, row2))
    print(f"Rows                 : {int(t['Rows'] or 0):,}")
    print(f"SUM(StockQty)        : {num(t['SumQty']):,.2f}  <- old KPI showed ~this")
    print(f"Distinct ItemId      : {int(t['DistinctItems'] or 0):,}")
    print(f"Distinct BranchId    : {int(t['DistinctBranches'] or 0):,}")
    print(f"Rows with StockQty>0 : {int(t['RowsPosQty'] or 0):,}")

    print("\n=== Dashboard expectation ===")
    print("Show slice Sum StockQty + distinct ItemId + distinct BranchId with disclaimer.")
    print("No chart (no date column). For valued stock use mb_powerbi_stock_report.")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
