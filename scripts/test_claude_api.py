"""
Smoke-test Anthropic Claude API connectivity.

Reads the API key from (first match wins):
  1. --api-key
  2. ANTHROPIC_API_KEY environment variable
  3. ANTHROPIC_API_KEY in repo-root .env

Never commit API keys. If you pasted a key in chat or code, rotate it in the Anthropic console.

Usage:
  set ANTHROPIC_API_KEY=sk-ant-api03-...
  python scripts/test_claude_api.py

  python scripts/test_claude_api.py --model claude-sonnet-4-6
  python scripts/test_claude_api.py --prompt "Reply with exactly: OK"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_MODEL = "claude-sonnet-4-6"
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"


def load_env_file(path: str) -> dict[str, str]:
    env: dict[str, str] = {}
    if not os.path.isfile(path):
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def resolve_api_key(cli_key: str | None, env_path: str) -> str:
    if cli_key and cli_key.strip():
        return cli_key.strip()
    from_os = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if from_os:
        return from_os
    from_file = (load_env_file(env_path).get("ANTHROPIC_API_KEY") or "").strip()
    return from_file


def resolve_model(cli_model: str | None, env_path: str) -> str:
    if cli_model and str(cli_model).strip():
        return str(cli_model).strip()
    from_os = (os.environ.get("ANTHROPIC_MODEL") or "").strip()
    if from_os:
        return from_os
    from_file = (load_env_file(env_path).get("ANTHROPIC_MODEL") or "").strip()
    return from_file or DEFAULT_MODEL


def mask_key(key: str) -> str:
    if len(key) <= 12:
        return "***"
    return f"{key[:10]}…{key[-4:]}"


def call_claude(
    api_key: str,
    *,
    model: str,
    prompt: str,
    max_tokens: int,
    timeout_s: int,
) -> dict:
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": API_VERSION,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def extract_text(payload: dict) -> str:
    parts: list[str] = []
    for block in payload.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts).strip()


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description="Test Anthropic Claude API")
    ap.add_argument("--api-key", default=None, help="Override ANTHROPIC_API_KEY")
    ap.add_argument("--env-file", default=os.path.join(root, ".env"), help="Path to .env")
    ap.add_argument(
        "--model",
        default=None,
        help=f"Model id (default: ANTHROPIC_MODEL from .env, else {DEFAULT_MODEL})",
    )
    ap.add_argument(
        "--prompt",
        default="Reply with exactly one word: pong",
        help="User message sent to the API",
    )
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    api_key = resolve_api_key(args.api_key, args.env_file)
    model = resolve_model(args.model, args.env_file)
    if not api_key:
        print(
            "Missing API key. Set ANTHROPIC_API_KEY or pass --api-key.\n"
            "Example: set ANTHROPIC_API_KEY=sk-ant-api03-...  (Windows cmd)",
            file=sys.stderr,
        )
        return 2

    print(f"Key: {mask_key(api_key)}")
    print(f"Model: {model}")
    print(f"POST {API_URL}")
    print("-" * 40)

    try:
        payload = call_claude(
            api_key,
            model=model,
            prompt=args.prompt,
            max_tokens=args.max_tokens,
            timeout_s=args.timeout,
        )
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} {e.reason}", file=sys.stderr)
        try:
            print(json.dumps(json.loads(err_body), indent=2), file=sys.stderr)
        except json.JSONDecodeError:
            print(err_body, file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}", file=sys.stderr)
        return 1

    text = extract_text(payload)
    usage = payload.get("usage") or {}
    print("OK — Claude API responded")
    print(f"  id:      {payload.get('id', '—')}")
    print(f"  model:   {payload.get('model', model)}")
    print(f"  stop:    {payload.get('stop_reason', '—')}")
    print(f"  tokens:  in={usage.get('input_tokens', '?')} out={usage.get('output_tokens', '?')}")
    print(f"  reply:   {text or '(empty)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
