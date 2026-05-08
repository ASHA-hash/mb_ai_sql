import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests


DEFAULT_API_BASE = "https://mb-ai-sql-v8wk.onrender.com"


@dataclass
class SuggestionCheck:
    question: str
    table_hint: str
    must_have_sql: List[str] = field(default_factory=list)
    must_have_any_sql: List[str] = field(default_factory=list)
    expected_any_columns: List[str] = field(default_factory=list)
    min_rows: int = 1


CHECKS: List[SuggestionCheck] = [
    SuggestionCheck(
        question="Top 10 products by total sales amount using readable ProductName (join dbo.VwAISalesData with dbo.VwMstItems on ItemId)",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["top (10)", "salenetamount"],
        must_have_any_sql=["vwai", "vwmstitems", "productname", "description", "articleshortname"],
        expected_any_columns=["ProductName", "Description", "ArticleShortName", "ItemId"],
    ),
    SuggestionCheck(
        question="Sum of SaleNetAmount grouped by BranchId",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["sum", "salenetamount", "group by", "branchid"],
        expected_any_columns=["BranchId"],
    ),
    SuggestionCheck(
        question="Highest revenue salesperson this month by SaleNetAmount",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["top (", "salenetamount"],
        must_have_any_sql=["salespersonid", "vwaisalesperson", "mstsalesperson"],
        expected_any_columns=["SalesPersonId", "SalespersonId", "SalesPersonName", "Name"],
    ),
    SuggestionCheck(
        question="Today's sales transactions with InvoiceNo, InvoiceDt, ItemId, Quantity, SaleNetAmount",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["invoicedt", "invoice", "salenetamount"],
        expected_any_columns=["InvoiceNo", "InvoiceDt", "ItemId", "Quantity", "SaleNetAmount"],
    ),
    SuggestionCheck(
        question="Low stock items — quantity less than 10",
        table_hint="dbo.VwAIStockData",
        must_have_sql=["top (", "10"],
        must_have_any_sql=["quantity", "qty"],
        min_rows=0,
    ),
    SuggestionCheck(
        question="Top 20 customers by total SaleNetAmount",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["top (20)", "salenetamount"],
        must_have_any_sql=["customerid", "customer", "group by"],
        expected_any_columns=["CustomerId", "CustomerName", "Name"],
    ),
    SuggestionCheck(
        question="Monthly sales trend for the last 6 months by InvoiceDt",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["invoicedt", "salenetamount"],
        must_have_any_sql=["month", "dateadd", "group by"],
        min_rows=0,
    ),
    SuggestionCheck(
        question="Branches with zero sales in the last 7 days",
        table_hint="dbo.VwAIBranch",
        must_have_sql=["top (", "branch"],
        must_have_any_sql=["dateadd(day,-7", "not exists", "left join", "having"],
        expected_any_columns=["BranchId", "BranchName", "Name"],
        min_rows=0,
    ),
    SuggestionCheck(
        question="Top 10 vendors by purchase amount from purchase report (use amount/value column, not quantity)",
        table_hint="dbo.VW_MB_POWERBI_PUR_REPORT",
        must_have_sql=["top (10)", "group by"],
        must_have_any_sql=["vendor", "supplier", "pur", "amount", "value"],
        min_rows=0,
    ),
    SuggestionCheck(
        question="Average order value by branch using SaleNetAmount per InvoiceId",
        table_hint="dbo.VwAISalesData",
        must_have_sql=["avg", "salenetamount", "branchid"],
        must_have_any_sql=["invoiceid", "group by"],
        expected_any_columns=["BranchId"],
    ),
]


def _low(s: Optional[str]) -> str:
    return str(s or "").lower()


def login_and_get_token(
    api_base: str,
    email: str,
    password: str,
    api_key: Optional[str],
    timeout: int = 180,
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
        raise RuntimeError(f"Login failed ({res.status_code}): {data}")
    token = data.get("token")
    if not token:
        raise RuntimeError("Login did not return token.")
    return token


def run_adaptive_query(
    api_base: str,
    question: str,
    table_hint: str,
    token: Optional[str],
    user_email: Optional[str],
    api_key: Optional[str],
    timeout: int = 240,
) -> Dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif user_email:
        headers["X-User-Email"] = user_email
    if api_key:
        headers["X-API-Key"] = api_key

    payload = {"question": question, "tableHint": table_hint}
    last_exc: Optional[Exception] = None
    for _ in range(3):
        try:
            res = requests.post(
                f"{api_base}/api/query/adaptive",
                headers=headers,
                json=payload,
                timeout=timeout,
            )
            body = res.json() if res.content else {}
            if not res.ok:
                raise RuntimeError(
                    f"HTTP {res.status_code}: {body.get('message') or body.get('error') or body}"
                )
            return body
        except requests.RequestException as exc:
            last_exc = exc
            time.sleep(2)
    raise RuntimeError(f"Request failed after retries: {last_exc}")


def validate_result(check: SuggestionCheck, result: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    sql = _low(result.get("sql"))
    rows = result.get("data") or []
    row_count = int(result.get("rowCount", len(rows)))

    for must in check.must_have_sql:
        if _low(must) not in sql:
            errors.append(f"SQL missing required token: {must}")

    if check.must_have_any_sql:
        if not any(_low(tok) in sql for tok in check.must_have_any_sql):
            errors.append(f"SQL missing any of expected tokens: {check.must_have_any_sql}")

    if row_count < check.min_rows:
        errors.append(f"Too few rows: got {row_count}, expected at least {check.min_rows}")

    if rows and check.expected_any_columns:
        keys = set(rows[0].keys())
        if not any(c in keys for c in check.expected_any_columns):
            errors.append(
                f"Result columns {sorted(keys)} missing expected any of {check.expected_any_columns}"
            )

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Cross-verify AI suggestions against adaptive query API.")
    parser.add_argument("--api-base", default=os.getenv("ERP_API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--email", default=os.getenv("ERP_EMAIL"))
    parser.add_argument("--password", default=os.getenv("ERP_PASSWORD"))
    parser.add_argument("--token", default=os.getenv("ERP_BEARER_TOKEN"))
    parser.add_argument("--api-key", default=os.getenv("ERP_API_KEY"))
    parser.add_argument("--sleep-sec", type=float, default=0.2)
    parser.add_argument("--json-out", default="ai_suggestions_verification.json")
    args = parser.parse_args()

    api_base = str(args.api_base).rstrip("/")
    if not api_base:
        print("Missing API base.", file=sys.stderr)
        return 2

    token = args.token
    if not token and args.email and args.password:
        token = login_and_get_token(api_base, args.email, args.password, args.api_key)

    reports: List[Dict[str, Any]] = []
    passed = 0

    for i, check in enumerate(CHECKS, start=1):
        print(f"[{i:02d}/{len(CHECKS)}] {check.question}")
        started = time.time()
        rec: Dict[str, Any] = {"question": check.question, "tableHint": check.table_hint}
        try:
            result = run_adaptive_query(
                api_base=api_base,
                question=check.question,
                table_hint=check.table_hint,
                token=token,
                user_email=args.email if not token else None,
                api_key=args.api_key,
            )
            rec["sql"] = result.get("sql")
            rec["rowCount"] = result.get("rowCount")
            rec["sampleRows"] = (result.get("data") or [])[:3]
            errors = validate_result(check, result)
            rec["errors"] = errors
            rec["status"] = "PASS" if not errors else "FAIL"
            if not errors:
                passed += 1
            print(f"    -> {rec['status']} ({round(time.time() - started, 1)}s)")
            if errors:
                for e in errors:
                    print(f"       - {e}")
        except Exception as exc:  # pylint: disable=broad-except
            rec["status"] = "ERROR"
            rec["errors"] = [str(exc)]
            print(f"    -> ERROR: {exc}")
        reports.append(rec)
        time.sleep(max(args.sleep_sec, 0))

    summary = {
        "total": len(CHECKS),
        "passed": passed,
        "failed_or_error": len(CHECKS) - passed,
        "generatedAtEpoch": int(time.time()),
        "reports": reports,
    }
    with open(args.json_out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, default=str)

    print("\n=== Summary ===")
    print(f"Passed: {passed}/{len(CHECKS)}")
    print(f"Report: {args.json_out}")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
