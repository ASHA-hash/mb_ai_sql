"""
Verified NL→SQL fast paths — skip LangGraph when question matches query-examples.json,
canonical patterns, or close fuzzy match. Uses sargable MTD filters and result cache.
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional

_MONTH_SHORT = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

_META = Path(__file__).parent.parent.parent / "metadata"
_EXAMPLES: list[dict] | None = None
_RESULT_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 300.0

# Optimized SQL overrides (normalized question → SQL). Faster than YEAR()/MONTH() on line facts.
_SQL_OVERRIDES: dict[str, str] = {
    "net purchase value by branch this month": (
        "SELECT TOP 50 BranchAlias, "
        "SUM(ISNULL(NetPurNetAmount, 0)) AS NetPurchase, "
        "SUM(ISNULL(NetPurQty, 0)) AS NetQty "
        "FROM dbo.VW_MB_POWERBI_PURXNS_REPORT WITH (NOLOCK) "
        "WHERE CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) "
        "AND CAST(XnDt AS date) <= CAST(GETDATE() AS date) "
        "GROUP BY BranchAlias ORDER BY NetPurchase DESC"
    ),
    "purchase returns this month by supplier": (
        "SELECT TOP 10 SupplierName, SUM(PrtQty) AS ReturnQty "
        "FROM dbo.VW_MB_POWERBI_PRT_REPORT WITH (NOLOCK) "
        "WHERE PurReturnDt >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) "
        "AND PurReturnDt <= CAST(GETDATE() AS date) "
        "GROUP BY SupplierName ORDER BY ReturnQty DESC"
    ),
    "top 10 vendors by purchase amount this month": (
        "SELECT TOP 10 SupplierName AS Vendor, SUM(ISNULL(NetPurNetAmount, 0)) AS TotalPurchase "
        "FROM dbo.VW_MB_POWERBI_PURXNS_REPORT WITH (NOLOCK) "
        "WHERE CAST(XnDt AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) "
        "AND CAST(XnDt AS date) <= CAST(GETDATE() AS date) "
        "GROUP BY SupplierName HAVING SUM(ISNULL(NetPurNetAmount, 0)) > 0 "
        "ORDER BY TotalPurchase DESC"
    ),
    "sales this month vs same month last year": "",  # filled by _build_sales_mtd_vs_ly_sql at resolve time
    "mtd sales total this month": "",  # filled by _build_sales_mtd_sql at resolve time
}

_PURCHASE_RETURN_SUPPLIER_MTD = re.compile(
    r"purchase\s+returns?.*(?:by\s+)?supplier|supplier.*purchase\s+returns?",
    re.I,
)
_NET_PURCHASE_BRANCH_MTD = re.compile(
    r"net\s+purchase.*\bbranch\b.*\b(month|mtd)\b|\bpurchase\s+value\b.*\bbranch\b",
    re.I,
)
_SALES_TODAY = re.compile(
    r"\b(today|todays|current\s+day)\b.*\b(sales?|revenue|turnover)\b|"
    r"\b(sales?|revenue|turnover)\b.*\b(today|todays|current\s+day)\b",
    re.I,
)
_HOW_MANY_SALES_TODAY = re.compile(
    r"\bhow\s+many\s+(sales?|bills?|transactions?|invoices?)\b.*\b(today|todays)\b|"
    r"\bhow\s+many\s+(sales?|bills?|transactions?)\s+today\b",
    re.I,
)
_SALES_YESTERDAY = re.compile(
    r"\b(yesterday|yesterdays|prior\s+day|previous\s+day)\b.*\b(sales?|revenue|turnover|total)\b|"
    r"\b(sales?|revenue|turnover|total)\b.*\b(yesterday|yesterdays)\b|"
    r"\byesterday\s+total\s+sales\b|"
    r"\btotal\s+sales?\s+yesterday\b",
    re.I,
)
_HOW_MANY_SALES_YESTERDAY = re.compile(
    r"\bhow\s+many\s+(sales?|bills?|transactions?|invoices?)\b.*\b(yesterday|yesterdays)\b|"
    r"\bhow\s+many\s+(sales?|bills?|transactions?)\s+yesterday\b",
    re.I,
)
_SALES_MTD_VS_LY = re.compile(
    r"\b(sales?|revenue|turnover)\b.*\b(this\s+)?month\b.*\b(vs|versus|compared)\b.*\b(last\s+year|same\s+month\s+last\s+year|ly)\b|"
    r"\b(this\s+)?month\b.*\b(vs|versus)\b.*\b(same\s+month\s+)?last\s+year\b.*\b(sales?|revenue)\b",
    re.I,
)
_SALES_MTD_TOTAL = re.compile(
    r"\b(mtd|month\s+to\s+date)\b.*\b(sales?|revenue|turnover)\b|"
    r"\b(sales?|revenue|turnover)\b.*\b(total|sum)\b.*\b(this\s+)?month\b|"
    r"\bmtd\s+sales?\s+total\b",
    re.I,
)


def normalize_question(q: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", (q or "").lower())).strip()


def _tokens(q: str) -> set[str]:
    return {t for t in normalize_question(q).split() if len(t) > 2}


def _fuzzy_example_match(nq: str) -> Optional[tuple[str, str]]:
    """Token overlap against query-examples when wording differs slightly."""
    q_tok = _tokens(nq)
    if len(q_tok) < 3:
        return None
    best: Optional[tuple[float, str, str]] = None
    for ex in _load_query_examples():
        eq = normalize_question(str(ex.get("question", "")))
        if not eq:
            continue
        e_tok = _tokens(eq)
        if not e_tok:
            continue
        inter = len(q_tok & e_tok)
        score = inter / max(len(q_tok), len(e_tok))
        if ex.get("category") == "sales_kpi" and "today" in q_tok and "today" in e_tok:
            score = max(score, 0.78)
        if ex.get("category") == "sales_kpi" and "yesterday" in q_tok and "yesterday" in e_tok:
            score = max(score, 0.78)
        if ex.get("category") == "sales_kpi" and "year" in q_tok and "month" in q_tok:
            score = max(score, 0.78)
        if score >= 0.78 and (best is None or score > best[0]):
            sql = str(ex.get("sql", "")).strip()
            if sql:
                best = (score, eq, sql)
    if best:
        return _resolve_example_sql(best[1], best[2]), "query_examples_fuzzy"
    return None


def _resolve_example_sql(normalized_eq: str, raw_sql: str) -> str:
    """Apply overrides + optimize + remap slow SLSXNS examples to analytics base table."""
    if normalized_eq == "sales this month vs same month last year":
        return _build_sales_mtd_vs_ly_sql()
    if normalized_eq == "mtd sales total this month":
        return _build_sales_mtd_sql()
    override = _SQL_OVERRIDES.get(normalized_eq, "").strip()
    if override:
        return override
    return _remap_sales_sql_to_analytics_base(_optimize_sql(raw_sql))


def _optimize_sql(sql: str) -> str:
    """Replace non-sargable YEAR/MONTH MTD filters with DATEFROMPARTS range."""
    s = sql
    for col in ("XnDt", "XnMemoDate", "PurReturnDt", "PurchaseDt", "PurInvoiceDt", "PurDate"):
        pat = (
            rf"YEAR\s*\(\s*CAST\s*\(\s*\[{col}\]\s*AS\s*date\s*\)\s*\)\s*=\s*YEAR\s*\(\s*GETDATE\s*\(\s*\)\s*\)\s*"
            rf"AND\s*MONTH\s*\(\s*CAST\s*\(\s*\[{col}\]\s*AS\s*date\s*\)\s*\)\s*=\s*MONTH\s*\(\s*GETDATE\s*\(\s*\)\s*\)"
        )
        repl = (
            f"CAST([{col}] AS date) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) "
            f"AND CAST([{col}] AS date) <= CAST(GETDATE() AS date)"
        )
        s = re.sub(pat, repl, s, flags=re.I)
        pat2 = (
            rf"YEAR\s*\(\s*CAST\s*\(\s*{col}\s*AS\s*date\s*\)\s*\)\s*=\s*YEAR\s*\(\s*GETDATE\s*\(\s*\)\s*\)\s*"
            rf"AND\s*MONTH\s*\(\s*CAST\s*\(\s*{col}\s*AS\s*date\s*\)\s*\)\s*=\s*MONTH\s*\(\s*GETDATE\s*\(\s*\)\s*\)"
        )
        s = re.sub(pat2, repl.replace(f"[{col}]", col), s, flags=re.I)
    if "PRT_REPORT" in s.upper() and "PurReturnDt >=" not in s:
        s = s.replace(
            "WHERE YEAR(CAST(PurReturnDt AS date))",
            "WHERE PurReturnDt >=",
        )
    # Last-year same calendar month (sargable; avoids full-table YEAR/MONTH scan)
    ly_pat = (
        r"YEAR\s*\(\s*CAST\s*\(\s*\[?(\w+)\]?\s*AS\s*date\s*\)\s*\)\s*=\s*YEAR\s*\(\s*GETDATE\s*\(\s*\)\s*\)\s*-\s*1\s*"
        r"AND\s*MONTH\s*\(\s*CAST\s*\(\s*\[?\1\]?\s*AS\s*date\s*\)\s*\)\s*=\s*MONTH\s*\(\s*GETDATE\s*\(\s*\)\s*\)"
    )
    s = re.sub(
        ly_pat,
        lambda m: (
            f"CAST([{m.group(1)}] AS date) >= DATEADD(month, -12, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) "
            f"AND CAST([{m.group(1)}] AS date) < DATEADD(month, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))"
        ),
        s,
        flags=re.I,
    )
    return _remap_sales_sql_to_analytics_base(s)


def _remap_sales_sql_to_analytics_base(sql: str) -> str:
    """Use ANALYTICS_BASE_TABLE (SLS_REPORT) instead of SLSXNS for period KPIs — much faster."""
    if not sql or "SLSXNS" not in sql.upper():
        return sql
    tbl = _primary_sales_table()
    if "SLSXNS" in tbl.upper():
        return sql
    amt = _pick_view_column(tbl, _amount_candidates(tbl), "SALES_ANALYTICS_AMOUNT_COLUMN", "NetAmount")
    dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
    s = re.sub(r"dbo\.VW_MB_POWERBI_SLSXNS_REPORT", tbl, sql, flags=re.I)
    for old in ("NetSlsNetAmount", "NetSlsMrpValue", "SlsMrpValue", "MrpValue", "SaleNetAmount"):
        if old.lower() != amt.lower():
            s = re.sub(rf"\[{old}\]", f"[{amt}]", s, flags=re.I)
            s = re.sub(rf"\b{old}\b", amt, s, flags=re.I)
    for old_dc in ("XnDt", "InvoiceDt", "CashmemoDt"):
        if old_dc.lower() != dc.lower():
            s = re.sub(rf"CAST\s*\(\s*\[{old_dc}\]", f"CAST([{dc}]", s, flags=re.I)
            s = re.sub(rf"CAST\s*\(\s*{old_dc}\s+AS", f"CAST([{dc}] AS", s, flags=re.I)
    if "SLS_REPORT" in tbl.upper() and "SLSXNS" not in tbl.upper():
        s = re.sub(r"SUM\s*\(\s*\[?BillCount\]?\s*\)", "COUNT(*)", s, flags=re.I)
        s = re.sub(r"SUM\s*\(\s*BillCount\s*\)", "COUNT(*)", s, flags=re.I)
    return s


def _build_sales_mtd_sql() -> str:
    tbl = _primary_sales_table()
    amt = _pick_view_column(tbl, _amount_candidates(tbl), "SALES_ANALYTICS_AMOUNT_COLUMN", "NetAmount")
    dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
    qty = _pick_view_column(tbl, _qty_candidates(tbl), "SALES_ANALYTICS_QTY_COLUMN", "NetSlsQty")
    bills = "CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)" if "SLSXNS" in tbl.upper() else "COUNT(*)"
    return (
        f"SELECT ISNULL(SUM([{amt}]), 0) AS MTDSales, "
        f"ISNULL(SUM([{qty}]), 0) AS MTDQty, "
        f"{bills} AS MTDBills "
        f"FROM {tbl} WITH (NOLOCK) "
        f"WHERE CAST([{dc}] AS DATE) >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) "
        f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
    )


def _fiscal_year_start_iso() -> str:
    """Indian FY — April 1 of current fiscal year."""
    today = date.today()
    y = today.year if today.month >= 4 else today.year - 1
    return f"{y}-04-01"


def _build_sales_mtd_vs_ly_sql() -> str:
    """Month-wise buckets: CY vs same calendar month LY (YTD from FY start through today)."""
    tbl = _primary_sales_table()
    amt = _pick_view_column(tbl, _amount_candidates(tbl), "SALES_ANALYTICS_AMOUNT_COLUMN", "NetAmount")
    dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
    d = f"CAST([{dc}] AS DATE)"
    fy = _fiscal_year_start_iso()
    return (
        f"SELECT YEAR({d}) AS Yr, MONTH({d}) AS Mo, SUM(ISNULL([{amt}], 0)) AS Sales "
        f"FROM {tbl} WITH (NOLOCK) WHERE "
        f"({d} >= '{fy}' AND {d} <= CAST(GETDATE() AS DATE)) OR "
        f"({d} >= DATEADD(year, -1, CAST('{fy}' AS DATE)) "
        f"AND {d} <= DATEADD(year, -1, CAST(GETDATE() AS DATE))) "
        f"GROUP BY YEAR({d}), MONTH({d}) ORDER BY Yr, Mo"
    )


def pivot_monthwise_cy_ly(rows: list[dict]) -> list[dict]:
    """Pivot Yr/Mo/Sales rows → chart rows like Analytics Home (TotalSales + PY_TotalSales)."""
    sales: dict[tuple[int, int], float] = {}
    for r in rows:
        try:
            yr = int(r.get("Yr") or r.get("yr") or 0)
            mo = int(r.get("Mo") or r.get("mo") or 0)
        except (TypeError, ValueError):
            continue
        if yr < 2000 or mo < 1 or mo > 12:
            continue
        sales[(yr, mo)] = sales.get((yr, mo), 0.0) + float(r.get("Sales") or r.get("sales") or 0)

    fy = datetime.strptime(_fiscal_year_start_iso(), "%Y-%m-%d").date()
    today = date.today()
    cur = date(fy.year, fy.month, 1)
    end = date(today.year, today.month, 1)
    out: list[dict] = []
    while cur <= end:
        cy = sales.get((cur.year, cur.month), 0.0)
        ly = sales.get((cur.year - 1, cur.month), 0.0)
        out.append({
            "label": f"{_MONTH_SHORT[cur.month - 1]} (CY vs LY)",
            "TotalSales": cy,
            "PY_TotalSales": ly,
        })
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return out


def _primary_sales_table() -> str:
    """Same rollup as Analytics dashboard — not line-level APP_REPORT."""
    import os
    from . import runtime_config as rc
    return (
        (os.getenv("ANALYTICS_BASE_TABLE") or "").strip()
        or str(rc.get("ANALYTICS_BASE_TABLE", "dbo.VW_MB_POWERBI_SLS_REPORT")).strip()
        or "dbo.VW_MB_POWERBI_SLS_REPORT"
    )


def _view_columns(table: str) -> set[str]:
    try:
        raw = json.loads((_META / "db_tables_views_columns.json").read_text(encoding="utf-8"))
        schema = {**raw.get("views", {}), **raw.get("tables", {})}
        key = table if table in schema else None
        if not key:
            for k in schema:
                if k.lower() == table.lower():
                    key = k
                    break
        if not key:
            return set()
        cols = schema[key].get("columns") or {}
        return set(cols.keys()) if isinstance(cols, dict) else set()
    except Exception:
        return set()


def _amount_candidates(table: str) -> list[str]:
    u = (table or "").upper()
    if "SLS_REPORT" in u and "SLSXNS" not in u:
        # MrpValue is APP_REPORT only — not on SLS_REPORT (causes SQL 207).
        return ["NetAmount", "SlsNetAmount", "NetSlsNetAmount"]
    if "SLSXNS" in u:
        return ["NetSlsNetAmount", "NetAmount"]
    if "APP_REPORT" in u:
        return ["MrpValue", "NetAmount", "SaleNetAmount"]
    return ["NetSlsNetAmount", "SlsNetAmount", "NetAmount", "MrpValue"]


def _qty_candidates(table: str) -> list[str]:
    u = (table or "").upper()
    if "SLS_REPORT" in u and "SLSXNS" not in u:
        return ["SlsQty", "NetSlsQty", "AppQty"]
    if "SLSXNS" in u:
        return ["NetSlsQty", "AppQty", "SlsQty"]
    return ["NetSlsQty", "SlsQty", "AppQty"]


def _date_candidates(table: str) -> list[str]:
    u = (table or "").upper()
    if "SLSXNS" in u:
        return ["XnDt", "XnMemoDate", "InvoiceDt"]
    if "SLS_REPORT" in u and "SLSXNS" not in u:
        return ["XnMemoDate", "XnDt", "InvoiceDt"]
    if "APP_REPORT" in u:
        return ["XnDt", "InvoiceDt"]
    return ["XnDt", "XnMemoDate", "InvoiceDt"]


def _pick_view_column(table: str, candidates: list[str], env_key: str, fallback: str) -> str:
    import os
    from . import runtime_config as rc
    view_cols = _view_columns(table)
    ev = (os.getenv(env_key) or str(rc.get(env_key, "") or "")).strip()
    u = (table or "").upper()
    # NetSlsNetAmount is for SLSXNS rollup; SLS_REPORT uses NetAmount / SlsNetAmount on live DB.
    if ev == "NetSlsNetAmount" and "SLS_REPORT" in u and "SLSXNS" not in u:
        ev = ""
    if ev and ev in candidates and (not view_cols or ev in view_cols):
        return ev
    for name in candidates:
        if not view_cols or name in view_cols:
            return name
    return fallback


def _build_sales_period_kpi_sql(
    tbl: str,
    dc: str,
    amt: str,
    qty: str,
    period: str,
    *,
    count_focus: bool = False,
) -> str:
    if period == "yesterday":
        where = f"CAST([{dc}] AS DATE) = CAST(DATEADD(DAY, -1, GETDATE()) AS DATE)"
        pfx = "Yesterday"
    else:
        where = f"CAST([{dc}] AS DATE) = CAST(GETDATE() AS DATE)"
        pfx = "Today"
    if "SLSXNS" in tbl.upper():
        bills_expr = "CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)"
    else:
        bills_expr = "COUNT(*)"
    if count_focus:
        return (
            f"SELECT {bills_expr} AS SalesCount, "
            f"ISNULL(SUM([{amt}]), 0) AS TotalSales, "
            f"ISNULL(SUM([{qty}]), 0) AS TotalQty "
            f"FROM {tbl} WITH (NOLOCK) WHERE {where}"
        )
    return (
        f"SELECT ISNULL(SUM([{amt}]), 0) AS {pfx}Sales, "
        f"ISNULL(SUM([{qty}]), 0) AS {pfx}Qty, "
        f"{bills_expr} AS {pfx}Bills "
        f"FROM {tbl} WITH (NOLOCK) WHERE {where}"
    )


def _sales_period_kpi_sql(period: str, *, count_focus: bool = False) -> str:
    tbl = _primary_sales_table()
    dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
    qty = _pick_view_column(tbl, _qty_candidates(tbl), "SALES_ANALYTICS_QTY_COLUMN", "NetSlsQty")
    amt = _pick_view_column(tbl, _amount_candidates(tbl), "SALES_ANALYTICS_AMOUNT_COLUMN", "NetAmount")
    return _build_sales_period_kpi_sql(tbl, dc, amt, qty, period, count_focus=count_focus)


def _sales_today_kpi_sql(*, count_focus: bool = False) -> str:
    return _sales_period_kpi_sql("today", count_focus=count_focus)


def _sales_yesterday_kpi_sql(*, count_focus: bool = False) -> str:
    return _sales_period_kpi_sql("yesterday", count_focus=count_focus)


def _sales_period_sql_variants(period: str, *, count_focus: bool = False) -> list[str]:
    """Multiple SQL variants — live DB columns may differ from metadata snapshot."""
    tbl = _primary_sales_table()
    view_cols = _view_columns(tbl)
    dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
    qty_opts = [c for c in _qty_candidates(tbl) if not view_cols or c in view_cols] or _qty_candidates(tbl)
    amt_meta = [c for c in _amount_candidates(tbl) if not view_cols or c in view_cols]
    amt_opts = list(dict.fromkeys(amt_meta + _amount_candidates(tbl)))
    qty = qty_opts[0]
    seen: set[str] = set()
    out: list[str] = []
    for amt in amt_opts:
        for q in qty_opts[:2]:
            sql = _build_sales_period_kpi_sql(tbl, dc, amt, q, period, count_focus=count_focus)
            if sql not in seen:
                seen.add(sql)
                out.append(sql)
    for dc_alt in _date_candidates(tbl):
        if dc_alt == dc:
            continue
        sql = _build_sales_period_kpi_sql(tbl, dc_alt, amt_opts[0], qty, period, count_focus=count_focus)
        if sql not in seen:
            seen.add(sql)
            out.append(sql)
    fallback = _sales_yesterday_kpi_sql if period == "yesterday" else _sales_today_kpi_sql
    return out or [fallback(count_focus=count_focus)]


def _sales_today_sql_variants(*, count_focus: bool = False) -> list[str]:
    return _sales_period_sql_variants("today", count_focus=count_focus)


def remap_generated_sales_sql(sql: str) -> str:
    """After LLM SQL: SLS_REPORT must not use MrpValue / APP_REPORT-only columns."""
    if not sql:
        return sql
    s = sql
    tbl = _primary_sales_table()
    u_tbl = tbl.upper()
    if "APP_REPORT" in sql.upper() and "SLS_REPORT" not in u_tbl:
        return s
    if "SLS_REPORT" in u_tbl or ("SLS_REPORT" in sql.upper() and "APP_REPORT" not in sql.upper()):
        amt = _pick_view_column(tbl, _amount_candidates(tbl), "SALES_ANALYTICS_AMOUNT_COLUMN", "NetAmount")
        dc = _pick_view_column(tbl, _date_candidates(tbl), "SALES_FILTER_DATE_COLUMN", "XnMemoDate")
        qty = _pick_view_column(tbl, _qty_candidates(tbl), "SALES_ANALYTICS_QTY_COLUMN", "NetSlsQty")
        for old in ("MrpValue", "NetSlsMrpValue", "SlsMrpValue", "SaleNetAmount", "AppQty"):
            if old.lower() != amt.lower() and re.search(rf"\b{old}\b", s, re.I):
                s = re.sub(rf"\[{old}\]", f"[{amt}]", s, flags=re.I)
                s = re.sub(rf"\b{old}\b", amt, s, flags=re.I)
        if "APP_REPORT" in s.upper():
            s = re.sub(r"dbo\.VW_MB_POWERBI_APP_REPORT", tbl, s, flags=re.I)
        for old_dc in ("XnDt", "InvoiceDt", "CashmemoDt"):
            if old_dc.lower() != dc.lower():
                s = re.sub(rf"CAST\s*\(\s*\[{old_dc}\]", f"CAST([{dc}]", s, flags=re.I)
        if qty != "AppQty":
            s = re.sub(r"\bAppQty\b", qty, s, flags=re.I)
        s = _remap_sales_sql_to_analytics_base(s)
    return s


async def execute_fast_path_sql(
    sql_raw: str,
    source: str,
    question: str,
    timeout_s: float,
) -> tuple[list[dict], str]:
    """
    Run fast-path SQL; for sales-today KPIs retry alternate column names when SQL Server 207.
    Returns (rows, sql_used).
    """
    import asyncio
    from .db_mssql import execute_query

    variants = [sql_raw]
    if source in ("sales_today_kpi", "sales_yesterday_kpi"):
        count_focus = bool(re.search(r"\bhow\s+many\b", question, re.I))
        period = "yesterday" if source == "sales_yesterday_kpi" else "today"
        variants = _sales_period_sql_variants(period, count_focus=count_focus)

    if source == "sales_mtd_vs_ly":
        sql = prepare_exec_sql(sql_raw)
        rows = await asyncio.wait_for(execute_query(sql), timeout=timeout_s)
        return pivot_monthwise_cy_ly(rows), sql

    last_err: Exception | None = None
    for raw in variants:
        sql = prepare_exec_sql(raw)
        try:
            rows = await asyncio.wait_for(execute_query(sql), timeout=timeout_s)
            return rows, sql
        except Exception as e:
            err_s = str(e)
            if "42S22" in err_s or "Invalid column name" in err_s:
                last_err = e
                continue
            raise
    if last_err:
        raise last_err
    return [], prepare_exec_sql(sql_raw)


def _resolve_sales_yesterday_sql(question: str) -> Optional[str]:
    q = question or ""
    if re.search(r"\bpurchase\b", q, re.I):
        return None
    if _HOW_MANY_SALES_YESTERDAY.search(q):
        return _sales_yesterday_kpi_sql(count_focus=True)
    if _SALES_YESTERDAY.search(q):
        return _sales_yesterday_kpi_sql(count_focus=False)
    nq = normalize_question(q)
    if nq in (
        "how many sales yesterday",
        "sales yesterday",
        "total sales yesterday",
        "yesterdays sales",
        "yesterday total sales",
        "yesterdays total sales",
    ):
        return _sales_yesterday_kpi_sql(count_focus="how" in nq and "many" in nq)
    tok = _tokens(nq)
    if "yesterday" in tok and ("sales" in tok or "sale" in tok or "total" in tok):
        return _sales_yesterday_kpi_sql(count_focus="how" in tok and "many" in tok)
    return None


def _resolve_sales_today_sql(question: str) -> Optional[str]:
    q = question or ""
    if _resolve_sales_yesterday_sql(q):
        return None
    if _HOW_MANY_SALES_TODAY.search(q):
        return _sales_today_kpi_sql(count_focus=True)
    if _SALES_TODAY.search(q) and not re.search(r"\bpurchase\b", q, re.I):
        return _sales_today_kpi_sql(count_focus=False)
    nq = normalize_question(q)
    if nq in ("how many sales today", "sales today", "total sales today", "todays sales"):
        return _sales_today_kpi_sql(count_focus="how many" in nq)
    tok = _tokens(nq)
    if "today" in tok and ("sales" in tok or "sale" in tok) and "purchase" not in tok:
        return _sales_today_kpi_sql(count_focus="how" in tok and "many" in tok)
    return None


def _load_query_examples() -> list[dict]:
    global _EXAMPLES
    if _EXAMPLES is not None:
        return _EXAMPLES
    try:
        raw = json.loads((_META / "query-examples.json").read_text(encoding="utf-8"))
        _EXAMPLES = raw if isinstance(raw, list) else raw.get("examples", [])
    except Exception:
        _EXAMPLES = []
    return _EXAMPLES


def _canonical_sql(question: str) -> Optional[str]:
    q = question or ""
    nq = normalize_question(q)
    if nq in _SQL_OVERRIDES:
        ov = _SQL_OVERRIDES[nq].strip()
        if ov:
            return ov
        if nq == "sales this month vs same month last year":
            return _build_sales_mtd_vs_ly_sql()
        if nq == "mtd sales total this month":
            return _build_sales_mtd_sql()
    if _PURCHASE_RETURN_SUPPLIER_MTD.search(q) and re.search(r"\b(this\s+)?month|mtd\b", q, re.I):
        return _SQL_OVERRIDES["purchase returns this month by supplier"]
    if _NET_PURCHASE_BRANCH_MTD.search(q):
        return _SQL_OVERRIDES["net purchase value by branch this month"]
    sales_yesterday = _resolve_sales_yesterday_sql(q)
    if sales_yesterday:
        return sales_yesterday
    sales_today = _resolve_sales_today_sql(q)
    if sales_today:
        return sales_today
    if _SALES_MTD_VS_LY.search(q):
        return _build_sales_mtd_vs_ly_sql()
    if _SALES_MTD_TOTAL.search(q) and not re.search(r"\bpurchase\b", q, re.I):
        return _build_sales_mtd_sql()
    return None


def resolve_fast_path_sql(
    question: str,
    user_date_range: Optional[dict] = None,
) -> Optional[tuple[str, str]]:
    """
    Returns (sql, source) or None.
    Skips fast path when user supplied custom from/to dates (stored SQL may not match).
    """
    if user_date_range:
        fr = (user_date_range.get("from") or "").strip()
        to = (user_date_range.get("to") or "").strip()
        if fr and to:
            return None

    nq = normalize_question(question)
    if not nq:
        return None

    sales_yesterday = _resolve_sales_yesterday_sql(question)
    if sales_yesterday:
        return sales_yesterday, "sales_yesterday_kpi"

    sales_today = _resolve_sales_today_sql(question)
    if sales_today:
        return sales_today, "sales_today_kpi"

    mtd_vs_ly = _build_sales_mtd_vs_ly_sql()
    if nq == "sales this month vs same month last year":
        return mtd_vs_ly, "sales_mtd_vs_ly"
    if nq == "mtd sales total this month":
        return _build_sales_mtd_sql(), "sales_mtd_kpi"

    if nq in _SQL_OVERRIDES:
        ov = _SQL_OVERRIDES[nq].strip()
        if ov:
            return ov, "canonical_override"
        if nq == "sales this month vs same month last year":
            return mtd_vs_ly, "sales_mtd_vs_ly"
        if nq == "mtd sales total this month":
            return _build_sales_mtd_sql(), "sales_mtd_kpi"

    for ex in _load_query_examples():
        eq = normalize_question(str(ex.get("question", "")))
        sql = str(ex.get("sql", "")).strip()
        if eq and sql and eq == nq:
            opt = _resolve_example_sql(eq, sql)
            src = "sales_mtd_vs_ly" if eq == "sales this month vs same month last year" else "query_examples_exact"
            if eq == "mtd sales total this month":
                src = "sales_mtd_kpi"
            return opt, src

    canon = _canonical_sql(question)
    if canon:
        return canon, "canonical_pattern"

    fuzzy = _fuzzy_example_match(nq)
    if fuzzy:
        return fuzzy

    return None


_YOY_COL_LABELS: dict[str, str] = {
    "ThisMonthSales": "This Month (MTD)",
    "LastYearMonthSales": "Same Month Last Year",
    "TodaySales": "Today",
    "YesterdaySales": "Yesterday",
    "MTDSales": "MTD Sales",
}


def shape_chart_rows(source: str, rows: list[dict]) -> list[dict]:
    """
    Wide KPI rows (1 row, 2+ metrics) → long format for bar/pie charts in AI Query UI.
    """
    if not rows:
        return rows
    if source == "sales_mtd_vs_ly":
        if rows and "TotalSales" in rows[0] and "PY_TotalSales" in rows[0]:
            return rows
        if len(rows) == 1:
            r = rows[0]
            cy = r.get("ThisMonthSales")
            ly = r.get("LastYearMonthSales")
            if cy is not None or ly is not None:
                out: list[dict] = []
                if cy is not None:
                    out.append({"label": _YOY_COL_LABELS["ThisMonthSales"], "TotalSales": cy, "PY_TotalSales": 0})
                if ly is not None:
                    out.append({"label": _YOY_COL_LABELS["LastYearMonthSales"], "TotalSales": 0, "PY_TotalSales": ly})
                return out or rows
    if len(rows) == 1:
        r = rows[0]
        nums = {k: v for k, v in r.items() if isinstance(v, (int, float)) and v is not None}
        strs = {k for k, v in r.items() if k not in nums}
        if len(nums) >= 2 and len(strs) <= 1:
            return [
                {"Label": _YOY_COL_LABELS.get(k, re.sub(r"([a-z])([A-Z])", r"\1 \2", k)), "Value": v}
                for k, v in nums.items()
            ]
    return rows


def prepare_exec_sql(sql: str, row_limit: int = 500) -> str:
    trimmed = (sql or "").strip()
    stripped = re.sub(r"/\*[\s\S]*?\*/", "", trimmed)
    stripped = re.sub(r"--[^\n]*", "", stripped).strip()
    upper = stripped.upper()
    if not upper.startswith("SELECT") and not upper.startswith("WITH"):
        raise ValueError("Only SELECT/WITH statements allowed")
    if re.search(r"\bGROUP\s+BY\b", upper):
        return trimmed
    if upper.startswith("SELECT") and not re.search(r"^\s*SELECT\s+TOP\s+\d+", trimmed, re.I):
        return re.sub(r"^\s*SELECT\s+", f"SELECT TOP {row_limit} ", trimmed, count=1, flags=re.I)
    return trimmed


def get_cached_result(nq: str) -> Optional[dict]:
    hit = _RESULT_CACHE.get(nq)
    if hit and (time.time() - hit[0]) < _CACHE_TTL:
        return hit[1]
    return None


def set_cached_result(nq: str, payload: dict) -> None:
    _RESULT_CACHE[nq] = (time.time(), payload)


def summarize_answer(question: str, rows: list[dict], source: str = "") -> str:
    if not rows:
        hint = ""
        if "PURXNS" in source.upper() or "purchase" in question.lower():
            hint = " Purchase line-level views can be slow; retry in a minute or use Analytics → MTD for sales."
        return f"No data found for your query.{hint}"
    if rows and source == "sales_mtd_vs_ly":
        if rows[0].get("TotalSales") is not None and rows[0].get("PY_TotalSales") is not None:
            cy_tot = sum(float(r.get("TotalSales") or 0) for r in rows)
            ly_tot = sum(float(r.get("PY_TotalSales") or 0) for r in rows)
            pct = ((cy_tot - ly_tot) / ly_tot * 100) if ly_tot else 0.0
            lines = [
                f"Month-wise sales CY vs LY ({_primary_sales_table()}), Indian FY from {_fiscal_year_start_iso()}:",
                f"  Current period (YTD): Rs {cy_tot / 1e5:.2f} Lakhs",
                f"  Same period last year: Rs {ly_tot / 1e5:.2f} Lakhs",
                f"  Overall change: {pct:+.1f}%",
            ]
            for r in rows:
                lbl = r.get("label") or r.get("Label") or "Month"
                c = float(r.get("TotalSales") or 0)
                l = float(r.get("PY_TotalSales") or 0)
                lines.append(f"  {lbl}: CY Rs {c / 1e5:.2f} L · LY Rs {l / 1e5:.2f} L")
            lines.append(
                "  Current month uses days through today in both years (see chart)."
            )
            return "\n".join(lines) + "."
        r = rows[0]
        cy_v = r.get("ThisMonthSales") or r.get("NetSales")
        ly_v = r.get("LastYearMonthSales")
        lines = [f"Sales comparison ({_primary_sales_table()}):"]
        try:
            c = float(cy_v or 0)
            lines.append(f"  This month (MTD): Rs {c / 1e5:.2f} Lakhs")
        except (TypeError, ValueError):
            lines.append(f"  This month (MTD): {cy_v}")
        try:
            l = float(ly_v or 0)
            lines.append(f"  Same month last year: Rs {l / 1e5:.2f} Lakhs")
            if l and cy_v is not None:
                pct = (float(cy_v) - l) / l * 100
                lines.append(f"  Change vs LY month: {pct:+.1f}%")
        except (TypeError, ValueError):
            lines.append(f"  Same month last year: {ly_v}")
        return "\n".join(lines) + "."
    if len(rows) == 1 and source.startswith("sales_today"):
        r = rows[0]
        bills = r.get("SalesCount") or r.get("TodayBills") or r.get("todaybills")
        sales = r.get("TotalSales") or r.get("TodaySales") or r.get("todaysales")
        qty = r.get("TotalQty") or r.get("TodayQty") or r.get("todayqty")
        parts = []
        if bills is not None:
            parts.append(f"{int(float(bills)):,} sales/bills today")
        if sales is not None:
            try:
                parts.append(f"₹{float(sales) / 1e5:.2f} Lakhs net sales")
            except (TypeError, ValueError):
                parts.append(f"net sales {sales}")
        if qty is not None:
            try:
                parts.append(f"{float(qty):,.0f} units")
            except (TypeError, ValueError):
                parts.append(f"qty {qty}")
        if parts:
            return f"Today ({_primary_sales_table()}): " + "; ".join(parts) + "."
    if len(rows) == 1 and source.startswith("sales_yesterday"):
        r = rows[0]
        bills = r.get("SalesCount") or r.get("YesterdayBills") or r.get("yesterdaybills")
        sales = r.get("TotalSales") or r.get("YesterdaySales") or r.get("yesterdaysales")
        qty = r.get("TotalQty") or r.get("YesterdayQty") or r.get("yesterdayqty")
        parts = []
        if sales is not None:
            try:
                parts.append(f"total sales amounted to ₹{float(sales) / 1e5:.2f} Lakhs")
            except (TypeError, ValueError):
                parts.append(f"total sales {sales}")
        if qty is not None:
            try:
                parts.append(f"a quantity of {float(qty):,.0f} items sold")
            except (TypeError, ValueError):
                parts.append(f"qty {qty}")
        if bills is not None:
            parts.append(f"across {int(float(bills)):,} bills")
        if parts:
            return f"Yesterday, " + ", ".join(parts) + "."
    keys = list(rows[0].keys())
    label_k = keys[0] if keys else "label"
    val_k = keys[1] if len(keys) > 1 else keys[0]
    lines = [f"Found {len(rows)} row(s) for: {question.strip()}"]
    for i, row in enumerate(rows[:8]):
        label = row.get(label_k, row.get(label_k.upper(), ""))
        val = row.get(val_k, row.get(val_k.upper(), 0))
        try:
            val_s = f"{float(val):,.2f}" if isinstance(val, (int, float)) else str(val)
        except (TypeError, ValueError):
            val_s = str(val)
        lines.append(f"  {i + 1}. {label}: {val_s}")
    if len(rows) > 8:
        lines.append(f"  … and {len(rows) - 8} more.")
    return "\n".join(lines)
