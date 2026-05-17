"""
Cross-check dbo.VwMstItems (Load Dataset key: vw_mst_items).

Item master / catalog — one row per SKU. The UI must NOT:
  - SUM(Itemcode) or ItemId (identifiers, not metrics)
  - SUM(ItemMRP / ItemWSP / ItemEXP across random TOP 500 rows (misleading portfolio KPI)

Usage:
  python scripts/verify_vw_mst_items.py
  python scripts/verify_vw_mst_items.py --limit 500

Requires: pyodbc, repo-root .env with DB_*.
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


def parse_schema_table(full: str) -> tuple[str, str]:
    s = (full or "").strip()
    if "." not in s:
        raise ValueError(f"Use schema.object — got {full!r}")
    a, b = s.split(".", 1)
    return sanitize_ident(a.strip()), sanitize_ident(b.strip())


def resolve_items_view(env: dict[str, str]) -> str:
    raw = (env.get("VW_MST_ITEMS_VIEW") or env.get("ITEMS_VIEW") or "").strip() or "dbo.VwMstItems"
    schema, obj = parse_schema_table(raw)
    return f"[{schema}].[{obj}]"


def to_float(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description="Verify VwMstItems catalog slice")
    ap.add_argument("--env", default=os.path.join(root, ".env"))
    ap.add_argument("--limit", type=int, default=500, help="TOP N (default 500, matches dashboard)")
    args = ap.parse_args()

    env = load_env(args.env)
    limit = max(1, int(args.limit))
    fq = resolve_items_view(env)
    print(f"View: {fq}")

    conn = connect_from_env(env)
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT_BIG(*) FROM {fq}")
    total = int(cur.fetchone()[0])
    print(f"\n=== Row counts ===\nFull view COUNT(*): {total:,}\nDashboard TOP (default): {limit:,}")

    cur.execute(f"SELECT TOP ({limit}) * FROM {fq} ORDER BY [Itemcode]")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    bogus_sum_itemcode = 0.0
    numeric_itemcodes = 0
    sum_mrp = 0.0
    sum_wsp = 0.0
    mrp_count = 0

    for r in rows:
        ic = r.get("Itemcode")
        s = str(ic or "").strip()
        if s and re.fullmatch(r"-?\d+(?:\.\d+)?", s):
            numeric_itemcodes += 1
            bogus_sum_itemcode += float(s)
        mrp = to_float(r.get("ItemMRP"))
        wsp = to_float(r.get("ItemWSP"))
        if mrp is not None:
            sum_mrp += mrp
            mrp_count += 1
        if wsp is not None:
            sum_wsp += wsp

    print(f"\n=== Sample (first 5) ===")
    for r in rows[:5]:
        print(
            f"  Itemcode={str(r.get('Itemcode') or '')[:20]:20} | "
            f"MRP={r.get('ItemMRP')} WSP={r.get('ItemWSP')} | "
            f"{str(r.get('Description') or '')[:30]}"
        )

    print("\n=== What the OLD dashboard wrongly showed ===")
    print(f"SUM(Itemcode) on TOP {len(rows)} (meaningless): {bogus_sum_itemcode:,.2f}")
    print(f"  ({numeric_itemcodes} rows had purely numeric Itemcode strings)")
    print(f"SUM(ItemMRP) on same slice: {sum_mrp:,.2f}  (avg {sum_mrp / mrp_count if mrp_count else 0:,.2f})")
    print(f"SUM(ItemWSP) on same slice: {sum_wsp:,.2f}")

    print("\n=== Expected dashboard (after fix) ===")
    print("Reference banner only — no KPI cards summing Itemcode / ItemMRP / ItemWSP.")
    print("Itemcode shown as text; ItemMRP/WSP formatted per row, not portfolio totals.")
    print("For stock value or sales: use stock, sales, or mb_powerbi_* transaction datasets.")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
