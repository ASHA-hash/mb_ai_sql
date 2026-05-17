"""
Cross-check dbo.VwAICustomerDetails (Load Dataset key: customers, env CUSTOMER_VIEW override).

The connector uses:
  SELECT TOP (@DATASET_HARD_CAP) * FROM <view>
with **no ORDER BY** for this dataset when date ordering is disabled (ignoreEnvDateColumn in registry),
so the TOP slice is **nondeterministic** unless SQL Server changes.

Verifies vs Load Dataset "All rows":
  - Full view COUNT(*)
  - Aggregates on TOP (cap) rows: SUM / AVG CreditLimit, count non-null numeric CreditLimit

Your KPI strip (Σ CreditLimit, avg, row count used in stat) should align with SUM/AVG on the same
logical slice; **Σ = 0 and avg = 0** with 20,000 rows means every CreditLimit in that slice is 0 / null.

Usage:
  python scripts/verify_customers_dataset.py
  python scripts/verify_customers_dataset.py --limit 20000

Requires: pyodbc, ODBC Driver 17/18, repo-root .env with DB_*.
Optional: set CUSTOMER_VIEW=dbo.VwAICustomerDetails in .env to match override.
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


def resolve_customer_view(env: dict[str, str]) -> str:
    raw = (env.get("CUSTOMER_VIEW") or "").strip() or "dbo.VwAICustomerDetails"
    schema, obj = parse_schema_table(raw)
    return f"[{schema}].[{obj}]"


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    default_env = os.path.join(root, ".env")
    ap = argparse.ArgumentParser(description="Verify customer master slice vs SQL")
    ap.add_argument("--env", default=default_env, help="Path to .env")
    ap.add_argument(
        "--limit",
        type=int,
        default=None,
        help="TOP N (default: DATASET_HARD_CAP from .env, usually 20000)",
    )
    args = ap.parse_args()

    env = load_env(args.env)
    hard_cap = int(env.get("DATASET_HARD_CAP", "20000") or "20000")
    limit = args.limit if args.limit is not None else hard_cap

    fq = resolve_customer_view(env)
    print(f"View: {fq}  (CUSTOMER_VIEW in .env overrides default dbo.VwAICustomerDetails)")

    conn = connect_from_env(env)
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) FROM {fq}")
    total = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total:,}\nTOP cap (All rows): {limit:,}")

    # Match index.js: no ORDER BY when dataset has no date column for ordering (customers master path).
    inner = f"SELECT TOP ({limit}) * FROM {fq}"
    sql = f"""
WITH slice AS (
  {inner}
)
SELECT
  COUNT_BIG(*) AS slice_rows,
  SUM(TRY_CONVERT(decimal(18, 2), [CreditLimit])) AS sum_credit,
  AVG(TRY_CONVERT(float, [CreditLimit])) AS avg_credit,
  SUM(CASE WHEN TRY_CONVERT(decimal(18,2), [CreditLimit]) IS NOT NULL THEN 1 ELSE 0 END) AS credit_non_null_cells,
  SUM(CASE WHEN TRY_CONVERT(decimal(18,2), [CreditLimit]) > 0 THEN 1 ELSE 0 END) AS credit_positive_rows
FROM slice;
"""
    cur.execute(sql)
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    out = dict(zip(cols, row))

    print("\n=== Aggregates on TOP slice (~ API dump without ORDER BY) ===")
    for k in cols:
        v = out[k]
        if v is None:
            print(f"  {k}: NULL")
            continue
        if isinstance(v, Decimal):
            v = float(v)
        if isinstance(v, float):
            print(f"  {k}: {v:,.6g}")
        else:
            print(f"  {k}: {v:,}")

    sr = int(out.get("slice_rows") or 0)
    sp = out.get("sum_credit")
    print("\n=== Interpretation ===")
    print(f"  Dashboard '{sr:,} row(s)' with cap {limit:,}: slice row count should match if total >= limit.")
    if total < limit:
        print(f"  View has only {total:,} rows — UI shows all of them.")
    print(
        "  SUM(CreditLimit) on a TOP slice is NOT total credit exposure — often all zeros in sample."
    )
    print(
        "  Expected dashboard: customer count, with-mobile, active, distinct branches — NOT Sum CreditLimit KPI."
    )
    print(
        "  Note: No date column — TOP without ORDER BY is an arbitrary sample, not 'newest customers'."
    )

    cur.execute(f"""
    SELECT
      SUM(CASE WHEN NULLIF(LTRIM(RTRIM([ContactMobile])), '') IS NOT NULL THEN 1 ELSE 0 END) AS with_mobile,
      SUM(CASE WHEN [ActiveStatus] = 1 OR LOWER(CAST([ActiveStatus] AS varchar(20))) = 'true' THEN 1 ELSE 0 END) AS active_rows
    FROM ({inner}) s
    """)
    row2 = cur.fetchone()
    if row2:
        print(f"\n=== Slice profile (dashboard-style KPIs) ===")
        print(f"  With ContactMobile : {int(row2[0] or 0):,}")
        print(f"  ActiveStatus true  : {int(row2[1] or 0):,}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
