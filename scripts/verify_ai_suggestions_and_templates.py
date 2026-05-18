"""
Cross-verify AI suggestion chips vs saved SQL templates:
  1) No duplicate question text between data/ai-query-suggestions.json and data/sql-templates.json
  2) Each bundled SQL executes on the live DB (read-only SELECT)

Usage (repo root):
  python scripts/verify_ai_suggestions_and_templates.py
  python scripts/verify_ai_suggestions_and_templates.py --timeout 300

Requires: pyodbc, ODBC Driver 17/18, .env with DB_*.
"""

from __future__ import annotations

import argparse
import json
import os
import re
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
            conn = pyodbc.connect(conn_str, timeout=120)
            print(f"Connected via {d}")
            return conn
        except pyodbc.Error as e:
            last = e
    raise RuntimeError(f"Could not connect: {last}") from last


def norm_question(text: str) -> str:
    s = re.sub(r"[^\w\s]", " ", str(text or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def check_no_overlap(suggestions: list, templates: list) -> list[str]:
    sug_norm = {norm_question(x.get("q") or "") for x in suggestions}
    tpl_norm = {norm_question(x.get("name") or "") for x in templates}
    overlap = sorted(sug_norm & tpl_norm)
    errors = []
    if overlap:
        errors.append("Suggestion/template name overlap: " + "; ".join(overlap))
    # Fuzzy: suggestion contained in template name or vice versa
    for s in sug_norm:
        if not s:
            continue
        for t in tpl_norm:
            if not t:
                continue
            if s == t or (len(s) > 20 and s in t) or (len(t) > 20 and t in s):
                errors.append(f"Near-duplicate text: suggestion '{s}' vs template '{t}'")
    return errors


def run_sql(cur, label: str, sql: str, timeout_sec: int) -> tuple[bool, str, float, int]:
    sql = (sql or "").strip()
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
        return False, str(e).split("\n")[0][:240], elapsed, 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    root = repo_root()
    env_path = os.path.join(root, ".env")
    sug_path = os.path.join(root, "data", "ai-query-suggestions.json")
    tpl_path = os.path.join(root, "data", "sql-templates.json")

    for p in (env_path, sug_path, tpl_path):
        if not os.path.isfile(p):
            print(f"Missing {p}", file=sys.stderr)
            return 2

    suggestions = load_json(sug_path)
    templates = load_json(tpl_path)

    if len(suggestions) != 10:
        print(f"WARN: expected 10 suggestions, got {len(suggestions)}")
    if len(templates) != 10:
        print(f"WARN: expected 10 templates, got {len(templates)}")

    overlap_errors = check_no_overlap(suggestions, templates)
    if overlap_errors:
        print("=== OVERLAP CHECK: FAIL ===")
        for e in overlap_errors:
            print(" ", e)
    else:
        print("=== OVERLAP CHECK: PASS (no shared question text) ===\n")

    env = load_env(env_path)
    conn = connect_from_env(env)
    cur = conn.cursor()

    fail_n = 0
    ok_n = 0

    print(f"=== SUGGESTIONS ({len(suggestions)}) ===\n")
    for i, item in enumerate(suggestions, 1):
        q = item.get("q", f"suggestion_{i}")
        ok, msg, elapsed, nrows = run_sql(cur, q, item.get("sql", ""), args.timeout)
        status = "PASS" if ok else "FAIL"
        if ok:
            ok_n += 1
        else:
            fail_n += 1
        print(f"[{status}] S{i}: {q}")
        print(f"       hint={item.get('hint', '')}")
        print(f"       {nrows} row(s)  ({elapsed:.2f}s)  {msg if not ok else ''}\n")

    print(f"=== TEMPLATES ({len(templates)}) ===\n")
    for tpl in templates:
        name = tpl.get("name", tpl.get("id", "?"))
        ok, msg, elapsed, nrows = run_sql(cur, name, tpl.get("sql", ""), args.timeout)
        status = "PASS" if ok else "FAIL"
        if ok:
            ok_n += 1
        else:
            fail_n += 1
        print(f"[{status}] {tpl.get('id', '?')}: {name}")
        print(f"       {nrows} row(s)  ({elapsed:.2f}s)  {msg if not ok else ''}\n")

    conn.close()
    total = len(suggestions) + len(templates)
    print(f"Summary: {ok_n} passed, {fail_n} failed, {total} SQL checks")
    if overlap_errors:
        print("Overlap check failed — fix duplicate labels before shipping.")
        return 1
    return 0 if fail_n == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
