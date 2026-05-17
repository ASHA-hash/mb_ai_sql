"""
Cross-check dbo.VW_MB_POWERBI_APP_REPORT (Load Dataset key: sales / mb_powerbi_app_report).

Validates dashboard KPI semantics on a TOP-N slice (default 500):
  - SUM(MrpValue), SUM(AppQty) on loaded lines
  - COUNT(DISTINCT XnNo) vs SUM(BillCount) — BillCount is 1 per line in this view

Usage:
  python scripts/verify_mb_powerbi_app_report.py
  python scripts/verify_mb_powerbi_app_report.py --from 2025-09-01 --to 2026-03-26 --limit 500

Requires: pyodbc, repo-root .env with DB_*.
Date column: MB_POWERBI_APP_REPORT_FILTER_DATE_COLUMN or XnDt (default).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date, timedelta
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


def resolve_view(env: dict[str, str]) -> str:
    raw = (
        env.get("SALES_VIEW")
        or env.get("VW_MB_POWERBI_APP_REPORT_VIEW")
        or ""
    ).strip() or "dbo.VW_MB_POWERBI_APP_REPORT"
    if "." not in raw:
        raw = f"dbo.{raw}"
    schema, obj = raw.split(".", 1)
    return f"[{sanitize_ident(schema)}].[{sanitize_ident(obj)}]"


def resolve_date_col(env: dict[str, str]) -> str:
    raw = (
        env.get("MB_POWERBI_APP_REPORT_FILTER_DATE_COLUMN")
        or env.get("SALES_FILTER_DATE_COLUMN")
        or "XnDt"
    ).strip()
    return sanitize_ident(raw)


def num(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, Decimal):
        return float(v)
    return float(v)


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    today = date.today()
    default_from = (today - timedelta(days=180)).isoformat()
    default_to = today.isoformat()

    ap = argparse.ArgumentParser(description="Verify APP_REPORT sales slice vs dashboard KPIs")
    ap.add_argument("--env", default=os.path.join(root, ".env"))
    ap.add_argument("--from", dest="from_date", default=default_from)
    ap.add_argument("--to", dest="to_date", default=default_to)
    ap.add_argument("--limit", type=int, default=500)
    args = ap.parse_args()

    env = load_env(args.env)
    fq = resolve_view(env)
    date_col = resolve_date_col(env)
    lim = max(1, int(args.limit))
    fr, to = args.from_date, args.to_date

    print(f"View: {fq}")
    print(f"Date: [{date_col}] {fr} .. {to}")
    print(f"TOP:  {lim} (newest first, API-style)")

    conn = connect_from_env(env)
    cur = conn.cursor()

    sql_slice = f"""
    SELECT
      COUNT(1) AS LineRows,
      SUM(ISNULL([MrpValue], 0)) AS SumMrpValue,
      SUM(ISNULL([AppQty], 0)) AS SumAppQty,
      SUM(ISNULL([NetAmount], 0)) AS SumNetAmount,
      SUM(ISNULL([BillCount], 0)) AS SumBillCount,
      COUNT(DISTINCT [XnNo]) AS DistinctBills
    FROM (
      SELECT TOP ({lim}) [MrpValue], [AppQty], [NetAmount], [BillCount], [XnNo]
      FROM {fq}
      WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
      ORDER BY CAST([{date_col}] AS date) DESC
    ) s
    """

    sql_full = f"""
    SELECT
      COUNT(1) AS LineRows,
      SUM(ISNULL([MrpValue], 0)) AS SumMrpValue,
      COUNT(DISTINCT [XnNo]) AS DistinctBills
    FROM {fq}
    WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
    """

    print("\n=== TOP slice (matches dashboard row cap) ===")
    cur.execute(sql_slice, (fr, to))
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    d = dict(zip(cols, row))
    lines = int(d["LineRows"] or 0)
    sum_mrp = num(d["SumMrpValue"])
    sum_qty = num(d["SumAppQty"])
    sum_net = num(d["SumNetAmount"])
    sum_bc = num(d["SumBillCount"])
    dist_bills = int(d["DistinctBills"] or 0)

    print(f"Lines loaded       : {lines:,}")
    print(f"SUM(MrpValue)      : {sum_mrp:,.2f}  (~{sum_mrp/1e5:.2f} L)")
    print(f"SUM(AppQty)        : {sum_qty:,.0f}")
    print(f"SUM(NetAmount)     : {sum_net:,.2f}  (secondary; prefer MrpValue for revenue)")
    print(f"SUM(BillCount)     : {sum_bc:,.0f}  WRONG as total bills when = line count")
    print(f"COUNT(DISTINCT XnNo): {dist_bills:,}  <- use this for bills in slice")

    print("\n=== Full date window (all rows) ===")
    cur.execute(sql_full, (fr, to))
    row2 = cur.fetchone()
    cols2 = [d[0] for d in cur.description]
    f = dict(zip(cols2, row2))
    print(f"Lines in range     : {int(f['LineRows'] or 0):,}")
    print(f"SUM(MrpValue)      : {num(f['SumMrpValue']):,.2f}")
    print(f"Distinct bills     : {int(f['DistinctBills'] or 0):,}")

    print("\n=== Dashboard expectation (after fix) ===")
    print("KPI cards: Sum MrpValue, Sum AppQty, Distinct bills (XnNo) — not SUM(BillCount) or duplicate NetAmount.")
    print("Chart: branches aggregated (not 500 separate line bars).")
    print("Note: Slice totals != full-period MTD unless you load all rows or use Analytics.")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
