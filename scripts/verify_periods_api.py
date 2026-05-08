"""
Verify analytics API period outputs in one shot.

Checks key presets:
  - mtd, qtd, ytd, last_30d, last_90d, last_180d (6M), custom

Also prints QTD vs YTD consistency checks:
  - same date window?
  - same totals/txn? (can drift slightly on live-changing data)

Usage:
  python scripts/verify_periods_api.py
  python scripts/verify_periods_api.py --base http://127.0.0.1:3000 --email you@example.com
  python scripts/verify_periods_api.py --custom-from 2026-04-01 --custom-to 2026-04-30
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def post_json(url: str, body: dict, headers: dict, timeout_s: int) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def call_with_retry(
    url: str,
    payload: dict,
    headers: dict,
    timeout_s: int,
    retries: int = 1,
) -> dict:
    last_err = None
    for _ in range(retries + 1):
        try:
            return post_json(url, payload, headers, timeout_s)
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise last_err


def pick(result: dict) -> dict:
    p = result.get("period", {}) if isinstance(result, dict) else {}
    kpi = result.get("kpi", {}) if isinstance(result, dict) else {}
    return {
        "preset": p.get("preset"),
        "from": p.get("from"),
        "to": p.get("to"),
        "totalSales": kpi.get("totalSales"),
        "txnCount": kpi.get("txnCount"),
        "activeDays": kpi.get("activeDays"),
        "dataVersion": result.get("dataVersion"),
        "cacheHit": result.get("cacheHit"),
        "cacheLayer": result.get("cacheLayer"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Cross-verify analytics periods via API")
    ap.add_argument("--base", default="http://127.0.0.1:3000", help="API base URL")
    ap.add_argument("--email", default="ashakarthikeyan24@gmail.com", help="RBAC email header")
    ap.add_argument("--dataset", default="sales", help="Dataset key")
    ap.add_argument("--timeout", type=int, default=120, help="Per-request timeout in seconds")
    ap.add_argument("--custom-from", default="2026-04-01", help="Custom period start yyyy-mm-dd")
    ap.add_argument("--custom-to", default="2026-04-30", help="Custom period end yyyy-mm-dd")
    args = ap.parse_args()

    endpoint = args.base.rstrip("/") + "/api/analytics/dashboard"
    headers = {
        "Content-Type": "application/json",
        "X-User-Email": args.email,
    }

    period_cases = {
        "mtd": {"period": "mtd", "timeout": max(20, args.timeout // 2), "retries": 0},
        "qtd": {"period": "qtd", "timeout": max(60, args.timeout), "retries": 1},
        "ytd": {"period": "ytd", "timeout": max(60, args.timeout), "retries": 1},
        "30d": {"period": "last_30d", "timeout": max(45, args.timeout), "retries": 1},
        "90d": {"period": "last_90d", "timeout": max(60, args.timeout), "retries": 1},
        "6m": {"period": "last_180d", "timeout": max(90, args.timeout), "retries": 1},
        "custom": {
            "period": "custom",
            "custom": {"from": args.custom_from, "to": args.custom_to},
            "timeout": max(45, args.timeout),
            "retries": 1,
        },
    }

    out: dict[str, dict] = {}
    for label, body in period_cases.items():
        timeout_s = int(body.get("timeout", args.timeout))
        retries = int(body.get("retries", 1))
        payload = {
            k: v for k, v in body.items() if k not in ("timeout", "retries")
        }
        payload = {
            **payload,
            "dataset": args.dataset,
            "loadPhase": "critical",
            "compact": True,
        }
        try:
            data = call_with_retry(endpoint, payload, headers, timeout_s=timeout_s, retries=retries)
            out[label] = pick(data)
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                err_body = ""
            out[label] = {"error": f"HTTP {e.code}", "body": err_body[:300]}
        except Exception as e:
            out[label] = {"error": str(e)}

    qtd = out.get("qtd", {})
    ytd = out.get("ytd", {})
    checks = {
        "qtd_ytd_same_range": qtd.get("from") == ytd.get("from") and qtd.get("to") == ytd.get("to"),
        "qtd_ytd_same_totals": qtd.get("totalSales") == ytd.get("totalSales"),
        "qtd_ytd_same_txn": qtd.get("txnCount") == ytd.get("txnCount"),
    }

    print(json.dumps({"periods": out, "checks": checks}, indent=2))

    # Non-zero only when required period calls fail.
    required = ("mtd", "qtd", "ytd", "6m")
    failed = [k for k in required if "error" in out.get(k, {})]
    if failed:
        print(f"\nFAILED required period checks: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

