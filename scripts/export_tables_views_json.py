import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Dict, Any, List

try:
    import pyodbc
except Exception as exc:
    print(f"pyodbc import failed: {exc}")
    sys.exit(2)


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
        raise RuntimeError("Missing DB_* values in .env")

    drivers = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server",
    ]
    last_err = None
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
            print(f"Connected using driver: {d}")
            return conn
        except Exception as exc:
            last_err = exc

    raise RuntimeError(f"Unable to connect with available drivers. Last error: {last_err}")


def fetch_objects_with_columns(conn) -> List[Dict[str, Any]]:
    sql = """
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
      c.NUMERIC_SCALE AS numeric_scale,
      c.DATETIME_PRECISION AS datetime_precision
    FROM INFORMATION_SCHEMA.TABLES t
    INNER JOIN INFORMATION_SCHEMA.COLUMNS c
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
     AND t.TABLE_NAME = c.TABLE_NAME
    WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
    ORDER BY t.TABLE_TYPE, t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION;
    """
    cur = conn.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    cur.close()
    return [
        {
            "object_schema": r.object_schema,
            "object_name": r.object_name,
            "object_type": r.object_type,
            "ordinal_position": int(r.ordinal_position),
            "column_name": r.column_name,
            "data_type": r.data_type,
            "is_nullable": (str(r.is_nullable).upper() == "YES"),
            "character_maximum_length": r.character_maximum_length,
            "numeric_precision": r.numeric_precision,
            "numeric_scale": r.numeric_scale,
            "datetime_precision": r.datetime_precision,
        }
        for r in rows
    ]


def build_inventory(records: List[Dict[str, Any]], db_name: str) -> Dict[str, Any]:
    tables: Dict[str, Any] = {}
    views: Dict[str, Any] = {}

    for rec in records:
        object_key = f"{rec['object_schema']}.{rec['object_name']}"
        bucket = tables if rec["object_type"] == "BASE TABLE" else views

        if object_key not in bucket:
            bucket[object_key] = {
                "schema": rec["object_schema"],
                "name": rec["object_name"],
                "type": "table" if rec["object_type"] == "BASE TABLE" else "view",
                "columns": {},
            }

        bucket[object_key]["columns"][rec["column_name"]] = {
            "ordinal_position": rec["ordinal_position"],
            "data_type": rec["data_type"],
            "is_nullable": rec["is_nullable"],
            "character_maximum_length": rec["character_maximum_length"],
            "numeric_precision": rec["numeric_precision"],
            "numeric_scale": rec["numeric_scale"],
            "datetime_precision": rec["datetime_precision"],
        }

    return {
        "database": db_name,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "tables": len(tables),
            "views": len(views),
            "total_objects": len(tables) + len(views),
        },
        "tables": tables,
        "views": views,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export SQL Server tables and views with column dictionaries to JSON."
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="Path to .env file (default: <repo>/.env).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output JSON path (default: metadata/db_tables_views_columns.json).",
    )
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(__file__))
    env_path = args.env_file or os.path.join(repo_root, ".env")
    out_path = args.out or os.path.join(repo_root, "metadata", "db_tables_views_columns.json")

    if not os.path.exists(env_path):
        print(f".env file not found: {env_path}", file=sys.stderr)
        return 2

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    env = load_env(env_path)
    conn = connect_from_env(env)
    try:
        records = fetch_objects_with_columns(conn)
    finally:
        conn.close()

    payload = build_inventory(records, db_name=env.get("DB_NAME", ""))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(
        f"Wrote {payload['counts']['total_objects']} objects "
        f"({payload['counts']['tables']} tables, {payload['counts']['views']} views) to {out_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
