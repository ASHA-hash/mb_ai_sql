"""
Cross-check dbo.VW_MB_POWERBI_SLS_REPORT (Load Dataset key: mb_powerbi_sls_report).

Validates date-filtered TOP-N slice (default 500, newest XnMemoDate first):
  - SUM(NetAmount), SUM(NetSlsQty)
  - Confirms MB_POWERBI_SLS_REPORT_FILTER_DATE_COLUMN or default XnMemoDate

Usage:
  python scripts/verify_mb_powerbi_sls_report.py
  python scripts/verify_mb_powerbi_sls_report.py --from 2025-12-01 --to 2026-05-16 --limit 500

Requires: pyodbc, repo-root .env with DB_*.
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
    raw = (env.get("MB_POWERBI_SLS_REPORT_VIEW") or "").strip() or "dbo.VW_MB_POWERBI_SLS_REPORT"
    if "." not in raw:
        raw = f"dbo.{raw}"
    schema, obj = raw.split(".", 1)
    return f"[{sanitize_ident(schema)}].[{sanitize_ident(obj)}]"


def resolve_date_col(env: dict[str, str]) -> str:
    raw = (env.get("MB_POWERBI_SLS_REPORT_FILTER_DATE_COLUMN") or "XnMemoDate").strip()
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

    ap = argparse.ArgumentParser(description="Verify SLS_REPORT date filter + TOP slice")
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
    print(f"TOP:  {lim} (newest first — same as GET /api/dataset/mb_powerbi_sls_report)")

    conn = connect_from_env(env)
    cur = conn.cursor()

    sql_slice = f"""
    SELECT
      COUNT(1) AS LineRows,
      SUM(ISNULL([NetAmount], 0)) AS SumNetAmount,
      SUM(ISNULL([NetSlsQty], 0)) AS SumNetSlsQty
    FROM (
      SELECT TOP ({lim}) [NetAmount], [NetSlsQty]
      FROM {fq}
      WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
      ORDER BY CAST([{date_col}] AS date) DESC
    ) s
    """

    sql_full = f"""
    SELECT
      COUNT(1) AS LineRows,
      SUM(ISNULL([NetAmount], 0)) AS SumNetAmount
    FROM {fq}
    WHERE CAST([{date_col}] AS date) BETWEEN ? AND ?
    """

    print("\n=== TOP slice (dashboard Load Dataset) ===")
    cur.execute(sql_slice, (fr, to))
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    d = dict(zip(cols, row))
    print(f"Lines loaded    : {int(d['LineRows'] or 0):,}")
    print(f"SUM(NetAmount)  : {num(d['SumNetAmount']):,.2f}  (~{num(d['SumNetAmount'])/1e5:.2f} L)")
    print(f"SUM(NetSlsQty)  : {num(d['SumNetSlsQty']):,.0f}")

    print("\n=== Full window (all rows in range) ===")
    cur.execute(sql_full, (fr, to))
    row2 = cur.fetchone()
    cols2 = [d[0] for d in cur.description]
    f = dict(zip(cols2, row2))
    print(f"Lines in range  : {int(f['LineRows'] or 0):,}")
    print(f"SUM(NetAmount)  : {num(f['SumNetAmount']):,.2f}")

    print("\nOK: If TOP slice returns in <2 min, API Load Dataset should not hang (restart npm after registry date defaults).")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
