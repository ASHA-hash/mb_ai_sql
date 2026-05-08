import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Tuple


DEFAULT_API_BASE = "https://mb-ai-sql-v8wk.onrender.com"
DEFAULT_DATASET_KEYS = [
    "sales",
    "stock",
    "customers",
    "branches",
    "vw_aimst_items",
    "vw_mst_items",
]


def _trim_base(url: str) -> str:
    return (url or "").rstrip("/")


def _request_json(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]] = None,
    body_obj: Optional[dict] = None,
    timeout: int = 120,
) -> Tuple[int, dict]:
    data = None
    req_headers = dict(headers or {})
    if body_obj is not None:
        data = json.dumps(body_obj).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url=url, method=method, headers=req_headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            payload = json.loads(raw) if raw.strip() else {}
            return int(resp.getcode()), payload
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            payload = {"error": raw or str(e)}
        return int(e.code), payload


def login_and_get_token(
    api_base: str,
    email: str,
    password: str,
    api_key: Optional[str] = None,
    timeout: int = 120,
) -> str:
    headers: Dict[str, str] = {}
    if api_key:
        headers["X-API-Key"] = api_key
    code, body = _request_json(
        "POST",
        f"{api_base}/api/auth/login",
        headers=headers,
        body_obj={"email": email, "password": password},
        timeout=timeout,
    )
    if code < 200 or code >= 300:
        msg = body.get("message") or body.get("error") or body
        raise RuntimeError(f"Login failed ({code}): {msg}")
    token = body.get("token")
    if not token:
        raise RuntimeError("Login did not return token")
    return str(token)


def check_dataset(api_base: str, key: str, headers: Dict[str, str], timeout: int = 120) -> Tuple[bool, str]:
    query = urllib.parse.urlencode({"limit": "1"})
    url = f"{api_base}/api/dataset/{urllib.parse.quote(key)}?{query}"
    code, body = _request_json("GET", url, headers=headers, timeout=timeout)
    if 200 <= code < 300:
        rows = body.get("data") or []
        return True, f"OK ({len(rows)} row sample)"
    msg = body.get("message") or body.get("error") or str(body)
    return False, f"HTTP {code}: {msg}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Check SQL view SELECT permissions via ERP API dataset endpoints.")
    parser.add_argument("--api-base", default=os.getenv("ERP_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--api-key", default=os.getenv("ERP_API_KEY"))
    parser.add_argument("--token", default=os.getenv("ERP_BEARER_TOKEN"))
    parser.add_argument("--email", default=os.getenv("ERP_EMAIL"))
    parser.add_argument("--password", default=os.getenv("ERP_PASSWORD"))
    parser.add_argument(
        "--keys",
        default=",".join(DEFAULT_DATASET_KEYS),
        help="Comma-separated dataset keys to test (default: common keys).",
    )
    args = parser.parse_args()

    api_base = _trim_base(str(args.api_base))
    if not api_base:
        print("Missing --api-base or ERP_API_BASE.", file=sys.stderr)
        return 2

    keys = [k.strip() for k in str(args.keys).split(",") if k.strip()]
    if not keys:
        print("No dataset keys provided.", file=sys.stderr)
        return 2

    headers: Dict[str, str] = {}
    if args.api_key:
        headers["X-API-Key"] = str(args.api_key)

    token = str(args.token or "").strip()
    email = str(args.email or "").strip()
    password = str(args.password or "").strip()

    if not token and email and password:
        token = login_and_get_token(api_base, email, password, args.api_key)

    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif email:
        headers["X-User-Email"] = email

    print(f"API base: {api_base}")
    print(f"Testing keys: {', '.join(keys)}")
    print("-" * 72)

    failed: List[Tuple[str, str]] = []
    for key in keys:
        ok, msg = check_dataset(api_base, key, headers=headers)
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {key:<16} {msg}")
        if not ok:
            failed.append((key, msg))

    print("-" * 72)
    if failed:
        print("Failed checks:")
        for key, msg in failed:
            print(f" - {key}: {msg}")
        return 1

    print("All dataset permission checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
