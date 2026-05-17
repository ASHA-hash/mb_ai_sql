"""
Cross-check dbo.VwAISalesPerson (Load Dataset key: vw_ai_salesperson).

This view is a **reference master** (SalesPersonId, SalesPersonName, SalesPersonShortName).
It is NOT transactional sales — summing ShortName as currency in the UI was a bug (fixed in dashboard.html).

Usage:
  python scripts/verify_vw_ai_salesperson.py
  python scripts/verify_vw_ai_salesperson.py --limit 500

Requires: pyodbc, repo-root .env with DB_*.
Optional: VW_AI_SALESPERSON_VIEW=dbo.VwAISalesPerson (or override table).
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


def resolve_salesperson_view(env: dict[str, str]) -> str:
    raw = (env.get("VW_AI_SALESPERSON_VIEW") or "").strip() or "dbo.VwAISalesPerson"
    schema, obj = parse_schema_table(raw)
    return f"[{schema}].[{obj}]"


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description="Verify VwAISalesPerson master slice")
    ap.add_argument("--env", default=os.path.join(root, ".env"))
    ap.add_argument("--limit", type=int, default=500, help="TOP N rows (default 500)")
    args = ap.parse_args()

    env = load_env(args.env)
    limit = max(1, int(args.limit))
    fq = resolve_salesperson_view(env)
    print(f"View: {fq}")

    conn = connect_from_env(env)
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) FROM {fq}")
    total = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total:,}\nSample TOP: {limit:,}")

    cur.execute(f"SELECT TOP ({limit}) * FROM {fq} ORDER BY [SalesPersonId]")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    print(f"\nColumns: {', '.join(cols)}")

    numeric_short = 0
    empty_short = 0
    for r in rows:
        sn = r.get("SalesPersonShortName")
        s = str(sn or "").strip()
        if not s:
            empty_short += 1
        elif re.fullmatch(r"-?\d+(?:\.\d+)?", s):
            numeric_short += 1

    print(f"\n=== Sample (first 10) ===")
    for r in rows[:10]:
        print(
            f"  {r.get('SalesPersonId')!r:18} | "
            f"{str(r.get('SalesPersonName') or '')[:28]:28} | "
            f"{str(r.get('SalesPersonShortName') or '')!r}"
        )

    print("\n=== UI sanity (dashboard must NOT treat ShortName as revenue) ===")
    print(f"Rows in sample: {len(rows)}")
    print(f"Empty SalesPersonShortName: {empty_short}")
    print(f"Pure-numeric ShortName (internal codes — old UI wrongly summed as Lakhs): {numeric_short}")
    print(
        "\nNote: In this DB, SalesPersonShortName is often a numeric staff code (e.g. '116'), not a display label."
    )
    print(
        "Expected dashboard: reference banner, plain text table, no '1.92 L' KPI on ShortName."
    )
    print("For sales by person: dataset 'sales' or 'mb_powerbi_sls_data_without_itemid'.")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
