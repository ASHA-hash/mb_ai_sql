import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

import requests


DEFAULT_API_BASE = "https://mb-ai-sql-v8wk.onrender.com"
QUESTION = (
    "Top 10 products by total sales amount with readable product names. "
    "Use dbo.VwAISalesData joined with dbo.VwMstItems on ItemId. "
    "Return ProductName as "
    "COALESCE(NULLIF(LTRIM(RTRIM(Description)), ''), "
    "NULLIF(LTRIM(RTRIM(ArticleShortName)), ''), "
    "NULLIF(LTRIM(RTRIM(Itemcode)), ''), ItemId), "
    "and SUM(SaleNetAmount) as TotalSalesAmount. "
    "Group by ProductName and order by TotalSalesAmount descending."
)
TABLE_HINT = "dbo.VwAISalesData"


def _trim_base(url: str) -> str:
    return (url or "").rstrip("/")


def login_and_get_token(
    api_base: str,
    email: str,
    password: str,
    api_key: Optional[str] = None,
    timeout: int = 120,
) -> str:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    res = requests.post(
        f"{api_base}/api/auth/login",
        headers=headers,
        json={"email": email, "password": password},
        timeout=timeout,
    )
    data = res.json() if res.content else {}
    if not res.ok:
        raise RuntimeError(
            f"Login failed ({res.status_code}): "
            f"{data.get('message') or data.get('error') or 'unknown error'}"
        )
    token = data.get("token")
    if not token:
        raise RuntimeError("Login response did not include token.")
    return token


def fetch_top_10(
    api_base: str,
    token: Optional[str] = None,
    user_email: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: int = 120,
) -> Dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if user_email:
        headers["X-User-Email"] = user_email
    if api_key:
        headers["X-API-Key"] = api_key

    payload = {"question": QUESTION, "tableHint": TABLE_HINT}
    res = requests.post(
        f"{api_base}/api/query/adaptive",
        headers=headers,
        json=payload,
        timeout=timeout,
    )
    data = res.json() if res.content else {}
    if not res.ok:
        raise RuntimeError(
            f"Query failed ({res.status_code}): "
            f"{data.get('message') or data.get('error') or 'unknown error'}"
        )
    return data


def _pick_product_key(row: Dict[str, Any]) -> Optional[str]:
    candidates = [
        "ProductName",
        "ItemName",
        "StockName",
        "ArticleName",
        "Product",
        "Item",
        "Stock",
        "Name",
    ]
    for key in candidates:
        if key in row:
            return key
    for key in row.keys():
        lk = key.lower()
        if "product" in lk or "item" in lk or "stock" in lk or "article" in lk:
            return key
    return None


def _pick_amount_key(row: Dict[str, Any]) -> Optional[str]:
    candidates = [
        "TotalSalesAmount",
        "SaleNetAmount",
        "NetAmount",
        "Amount",
        "TotalAmount",
        "SalesAmount",
    ]
    for key in candidates:
        if key in row:
            return key
    for key in row.keys():
        lk = key.lower()
        if "amount" in lk or ("sale" in lk and "net" in lk):
            return key
    return None


def print_table(rows: List[Dict[str, Any]]) -> None:
    if not rows:
        print("No rows returned.")
        return

    product_key = _pick_product_key(rows[0]) or list(rows[0].keys())[0]
    amount_key = _pick_amount_key(rows[0]) or (
        list(rows[0].keys())[1] if len(rows[0].keys()) > 1 else list(rows[0].keys())[0]
    )

    print(f"{'Rank':<5} {product_key:<45} {amount_key:>18}")
    print("-" * 72)
    for i, row in enumerate(rows[:10], start=1):
        product = str(row.get(product_key, ""))
        amount = row.get(amount_key, "")
        print(f"{i:<5} {product[:45]:<45} {str(amount):>18}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch top 10 products by total sales amount from ERP API."
    )
    parser.add_argument("--api-base", default=os.getenv("ERP_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--token", default=os.getenv("ERP_BEARER_TOKEN"))
    parser.add_argument("--api-key", default=os.getenv("ERP_API_KEY"))
    parser.add_argument("--email", default=os.getenv("ERP_EMAIL"))
    parser.add_argument("--password", default=os.getenv("ERP_PASSWORD"))
    parser.add_argument("--json", action="store_true", help="Print raw JSON response.")
    args = parser.parse_args()

    api_base = _trim_base(args.api_base)
    if not api_base:
        print("Missing API base URL.", file=sys.stderr)
        return 2

    token = args.token
    if not token and args.email and args.password:
        token = login_and_get_token(
            api_base=api_base,
            email=args.email,
            password=args.password,
            api_key=args.api_key,
        )

    result = fetch_top_10(
        api_base=api_base,
        token=token,
        user_email=args.email if not token else None,
        api_key=args.api_key,
    )

    print(f"SQL used: {result.get('sql', '(none)')}")
    rows = result.get("data") or []
    print(f"Rows returned: {result.get('rowCount', len(rows))}")

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    else:
        print_table(rows)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pylint: disable=broad-except
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
