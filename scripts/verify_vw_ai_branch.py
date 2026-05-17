"""
Cross-check dbo.VwAIBranch (Load Dataset key: branches).

One row per branch/store. No date column — TOP 500 usually returns the full master (~116 branches).

Usage:
  python scripts/verify_vw_ai_branch.py
  python scripts/verify_vw_ai_branch.py --limit 500

Requires: pyodbc, repo-root .env with DB_*.
Optional: BRANCH_VIEW=dbo.VwAIBranch
"""

from __future__ import annotations

import argparse
import os
import re
import sys

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


def resolve_branch_view(env: dict[str, str]) -> str:
    raw = (env.get("BRANCH_VIEW") or "").strip() or "dbo.VwAIBranch"
    if "." not in raw:
        raw = f"dbo.{raw}"
    schema, obj = raw.split(".", 1)
    return f"[{sanitize_ident(schema)}].[{sanitize_ident(obj)}]"


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description="Verify VwAIBranch master")
    ap.add_argument("--env", default=os.path.join(root, ".env"))
    ap.add_argument("--limit", type=int, default=500)
    args = ap.parse_args()

    lim = max(1, int(args.limit))
    fq = resolve_branch_view(load_env(args.env))
    print(f"View: {fq}")

    conn = connect_from_env(load_env(args.env))
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) FROM {fq}")
    total = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total:,}\nTOP request: {lim:,}")

    sql_top = f"""
    SELECT
      COUNT(1) AS rows_loaded,
      COUNT(DISTINCT [State]) AS distinct_state,
      COUNT(DISTINCT [City]) AS distinct_city,
      COUNT(DISTINCT [BranchId]) AS distinct_branch_id
    FROM (SELECT TOP ({lim}) * FROM {fq}) s
    """

    cur.execute(sql_top)
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    t = dict(zip(cols, row))

    print(f"\n=== TOP {lim} (dashboard default) ===")
    print(f"Rows returned       : {int(t['rows_loaded'] or 0):,}")
    print(f"Distinct BranchId   : {int(t['distinct_branch_id'] or 0):,}")
    print(f"Distinct State      : {int(t['distinct_state'] or 0):,}")
    print(f"Distinct City       : {int(t['distinct_city'] or 0):,}")

    if total <= lim:
        print(f"\nAll {total:,} branches fit in one load (UI shows {total:,} row(s)).")
    else:
        print(f"\nView has more than {lim:,} rows — increase cap to load all branches.")

    print("\n=== Dashboard expectation ===")
    print("KPI: branches loaded, distinct state/city — no SUM(PinCode), no date filter text.")
    print("Revenue by branch: use sales dataset (BranchAlias on APP_REPORT).")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
