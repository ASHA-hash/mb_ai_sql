"""
Execute every SQL in data/sql-templates.json against the live DB and report pass/fail.

Usage (repo root):
  python scripts/verify_sql_templates.py
  python scripts/verify_sql_templates.py --timeout 300

Requires: pyodbc, ODBC Driver 17/18, .env with DB_*.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

try:
    import pyodbc
except ImportError:
    print("Install pyodbc: pip install pyodbc", file=sys.stderr)
    raise SystemExit(2) from None


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
            return pyodbc.connect(conn_str, timeout=120)
        except pyodbc.Error as e:
            last = e
    raise RuntimeError(f"Could not connect: {last}") from last


def load_templates(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_one(cur, tpl: dict, timeout_sec: int) -> tuple[bool, str, float, int]:
    sql = (tpl.get("sql") or "").strip()
    if not sql:
        return False, "empty sql", 0.0, 0
    t0 = time.perf_counter()
    try:
        cur.execute(sql)
        rows = cur.fetchmany(500)
        elapsed = time.perf_counter() - t0
        if elapsed > timeout_sec:
            return False, f"slow ({elapsed:.1f}s > {timeout_sec}s)", elapsed, len(rows)
        return True, "ok", elapsed, len(rows)
    except pyodbc.Error as e:
        elapsed = time.perf_counter() - t0
        msg = str(e).split("\n")[0][:240]
        return False, msg, elapsed, 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=180, help="warn if query exceeds this many seconds")
    args = ap.parse_args()

    root = repo_root()
    env_path = os.path.join(root, ".env")
    tpl_path = os.path.join(root, "data", "sql-templates.json")
    if not os.path.isfile(env_path):
        print(f"Missing {env_path}", file=sys.stderr)
        return 2
    if not os.path.isfile(tpl_path):
        print(f"Missing {tpl_path}", file=sys.stderr)
        return 2

    templates = load_templates(tpl_path)
    env = load_env(env_path)
    conn = connect_from_env(env)
    cur = conn.cursor()

    print(f"Verifying {len(templates)} saved SQL templates against {env.get('DB_NAME')} …\n")
    ok_n = 0
    fail_n = 0
    for tpl in templates:
        tid = tpl.get("id", "?")
        name = tpl.get("name", tid)
        ok, msg, elapsed, nrows = run_one(cur, tpl, args.timeout)
        status = "PASS" if ok else "FAIL"
        if ok:
            ok_n += 1
        else:
            fail_n += 1
        row_note = f"{nrows} row(s)" if ok else msg
        print(f"[{status}] {tid}")
        print(f"       {name}")
        print(f"       {row_note}  ({elapsed:.2f}s)\n")

    conn.close()
    print(f"Summary: {ok_n} passed, {fail_n} failed, {len(templates)} total")
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
