#!/usr/bin/env python3
"""
List SQL Server tables and views with columns, grouped by coarse type category,
and save a human-readable Markdown report.

Uses the same DB_* variables as the Node API (.env.example).

  pip install pyodbc
  python scripts/list_tables_columns_categorized.py
  python scripts/list_tables_columns_categorized.py --schema dbo --out metadata/my-schema.md
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

try:
    import pyodbc
except ImportError as exc:
    print("Install pyodbc:  pip install pyodbc", file=sys.stderr)
    raise SystemExit(2) from exc


def load_env(path: str) -> Dict[str, str]:
    env: Dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def connect_from_env(env: Dict[str, str]):
    server = env.get("DB_SERVER")
    port = env.get("DB_PORT", "1433")
    db = env.get("DB_NAME")
    user = env.get("DB_USER")
    pwd = env.get("DB_PASSWORD")
    encrypt = (env.get("DB_ENCRYPT", "false") or "false").lower() in ("1", "true", "yes")

    if not all([server, db, user, pwd]):
        raise RuntimeError("Missing DB_SERVER, DB_NAME, DB_USER, or DB_PASSWORD in .env")

    drivers = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ]
    last_err: Optional[Exception] = None
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
            conn = pyodbc.connect(conn_str, timeout=30)
            print(f"Connected using driver: {d}", file=sys.stderr)
            return conn
        except Exception as exc:
            last_err = exc
    raise RuntimeError(f"Unable to connect. Last error: {last_err}")


def type_category(data_type: str) -> str:
    """Bucket INFORMATION_SCHEMA.DATA_TYPE into a short label for the report."""
    t = (data_type or "").strip().lower()
    if t in ("tinyint", "smallint", "int", "bigint"):
        return "Integers"
    if t in ("bit",):
        return "Bit"
    if t in ("decimal", "numeric", "money", "smallmoney", "float", "real"):
        return "Decimals / numeric"
    if t in ("date", "datetime", "datetime2", "smalldatetime", "datetimeoffset", "time"):
        return "Dates & times"
    if t in ("char", "varchar", "nchar", "nvarchar", "text", "ntext"):
        return "Strings & text"
    if t in ("binary", "varbinary", "image"):
        return "Binary"
    if t in ("uniqueidentifier",):
        return "UUID"
    if t in ("xml",):
        return "XML"
    if t in ("sql_variant",):
        return "sql_variant"
    return "Other"


_NAME_HINTS: List[Tuple[re.Pattern[str], str]] = [
    (re.compile(r"(^|_)(id|key)$", re.I), "key/id"),
    (re.compile(r"date|time|dt$|_at$", re.I), "date-like name"),
    (re.compile(r"amount|amt|price|cost|qty|quantity|total|net|gross", re.I), "measure"),
    (re.compile(r"name|title|desc|remark|comment|note", re.I), "description"),
    (re.compile(r"code|no|num|number|ref", re.I), "code/ref"),
    (re.compile(r"flag|is_|has_|active|enabled|status", re.I), "flag/status"),
]


def name_hints(column_name: str) -> str:
    n = column_name or ""
    tags = [label for pat, label in _NAME_HINTS if pat.search(n)]
    return ", ".join(tags) if tags else ""


def format_column_line(
    col_name: str,
    data_type: str,
    is_nullable: bool,
    char_max: Any,
    num_prec: Any,
    num_scale: Any,
) -> str:
    type_display = data_type or ""
    if char_max is not None and char_max not in (-1,):
        try:
            cm = int(char_max)
            if cm >= 0:
                type_display += f"({cm})" if cm < 2147483647 else "(max)"
        except (TypeError, ValueError):
            pass
    elif num_prec is not None:
        try:
            p = int(num_prec)
            s = int(num_scale) if num_scale is not None else None
            type_display += f"({p},{s})" if s is not None else f"({p})"
        except (TypeError, ValueError):
            pass
    null_lbl = "NULL" if is_nullable else "NOT NULL"
    hints = name_hints(col_name)
    hint_suffix = f" — *{hints}*" if hints else ""
    return f"- `{col_name}` — **{type_display}** — {null_lbl}{hint_suffix}"


def fetch_rows(conn, schema_filter: Optional[str]) -> List[Any]:
    schema_clause = ""
    params: List[str] = []
    if schema_filter:
        schema_clause = " AND t.TABLE_SCHEMA = ? "
        params.append(schema_filter)

    sql = f"""
    SELECT
      t.TABLE_SCHEMA AS object_schema,
      t.TABLE_NAME AS object_name,
      t.TABLE_TYPE AS object_type,
      c.ORDINAL_POSITION AS ordinal_position,
      c.COLUMN_NAME AS column_name,
      c.DATA_TYPE AS data_type,
      c.IS_NULLABLE AS is_nullable,
      c.CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
      c.NUMERIC_PRECISION AS numeric_precision,
      c.NUMERIC_SCALE AS numeric_scale
    FROM INFORMATION_SCHEMA.TABLES t
    INNER JOIN INFORMATION_SCHEMA.COLUMNS c
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
     AND t.TABLE_NAME = c.TABLE_NAME
    WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      {schema_clause}
    ORDER BY t.TABLE_TYPE DESC, t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION;
    """
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows


def build_markdown(
    rows: List[Any],
    database: str,
    schema_filter: Optional[str],
) -> str:
    # object_key -> list of row tuples-like objects
    by_object: Dict[str, List[Any]] = defaultdict(list)
    for r in rows:
        key = f"{r.object_schema}.{r.object_name}"
        by_object[key].append(r)

    type_counts: Counter[str] = Counter()
    for r in rows:
        type_counts[type_category(r.data_type)] += 1

    lines: List[str] = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append("# SQL Server — tables, views & columns (categorized)")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"| Field | Value |")
    lines.append(f"| --- | --- |")
    lines.append(f"| Database | `{database}` |")
    lines.append(f"| Schema filter | `{schema_filter or '(all user schemas)'}` |")
    lines.append(f"| Generated | {now} |")
    lines.append(f"| Distinct objects | {len(by_object)} |")
    lines.append(f"| Total columns | {len(rows)} |")
    lines.append("")
    lines.append("### Columns by coarse SQL type category")
    lines.append("")
    for cat, n in sorted(type_counts.items(), key=lambda x: (-x[1], x[0])):
        lines.append(f"- **{cat}**: {n}")
    lines.append("")
    lines.append(
        "*Name hints* (italic under each column) are **heuristic** labels from the column name — "
        "not inferred from data."
    )
    lines.append("")
    lines.append("---")
    lines.append("")

    category_order = [
        "Integers",
        "Bit",
        "Decimals / numeric",
        "Dates & times",
        "Strings & text",
        "Binary",
        "UUID",
        "XML",
        "sql_variant",
        "Other",
    ]

    def emit_section(title: str, table_type: str) -> None:
        objs = [
            (k, v)
            for k, v in sorted(by_object.items())
            if v and str(v[0].object_type) == table_type
        ]
        if not objs:
            return
        lines.append(f"## {title}")
        lines.append("")
        for obj_key, cols in objs:
            r0 = cols[0]
            lines.append(f"### `{obj_key}` ({len(cols)} columns)")
            lines.append("")
            by_cat: Dict[str, List[Any]] = defaultdict(list)
            for c in cols:
                by_cat[type_category(c.data_type)].append(c)
            for cat in category_order:
                if cat not in by_cat:
                    continue
                lines.append(f"#### {cat}")
                lines.append("")
                for c in sorted(by_cat[cat], key=lambda x: int(x.ordinal_position)):
                    is_null = str(c.is_nullable).upper() == "YES"
                    lines.append(
                        format_column_line(
                            c.column_name,
                            c.data_type,
                            is_null,
                            c.character_maximum_length,
                            c.numeric_precision,
                            c.numeric_scale,
                        )
                    )
                lines.append("")

    emit_section("BASE TABLE (tables)", "BASE TABLE")
    emit_section("VIEW", "VIEW")

    lines.append("---")
    lines.append("")
    lines.append("*End of report.*")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export SQL Server tables/views and columns to a categorized Markdown file."
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="Path to .env (default: <repo>/.env).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output Markdown path (default: metadata/schema_inventory_categorized.md).",
    )
    parser.add_argument(
        "--schema",
        default=None,
        help="If set, only include objects in this schema (e.g. dbo).",
    )
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = args.env_file or os.path.join(repo_root, ".env")
    out_path = args.out or os.path.join(repo_root, "metadata", "schema_inventory_categorized.md")

    if not os.path.exists(env_path):
        print(f".env not found: {env_path}", file=sys.stderr)
        return 2

    env = load_env(env_path)
    conn = connect_from_env(env)
    try:
        rows = fetch_rows(conn, args.schema)
    finally:
        conn.close()

    md = build_markdown(rows, database=env.get("DB_NAME", ""), schema_filter=args.schema)
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)

    print(f"Wrote {len(rows)} column rows across objects to:\n  {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
