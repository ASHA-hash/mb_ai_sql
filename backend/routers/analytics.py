"""
Analytics router — dashboard KPIs, period reports, branch drilldown.
Mirrors the /api/analytics/* endpoints in index.js.
"""
import asyncio
import json
import os
import re
import time
from datetime import datetime, timedelta, date
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Any

from fastapi import APIRouter, Depends, Query

from ..services.auth import get_current_user
from ..services.db_mssql import execute_query
from ..services import runtime_config as rc
from ..services.analytics_period import (
    cross_filter_clause,
    intersect_range,
    parse_cross_filter_json,
    period_chip_range,
    range_to_where,
)

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

_META = Path(__file__).parent.parent.parent / "metadata"
_ROLE_CANDIDATES: dict[str, list[str]] = {
    "amount": ["SlsNetAmount", "NetAmount", "NetSlsNetAmount", "MrpValue", "SaleNetAmount", "SalesNetAmount"],
    "qty": ["AppQty", "NetSlsQty", "SlsQty", "Quantity"],
    "invoice": ["XnNo", "InvoiceNo", "BillCount"],
    "customer": ["XnId", "CustomerId", "UserKey"],
    "branch": ["BranchAlias", "BranchName", "BranchShortName"],
    "dept": ["DepartmentShortName", "DepartmentName", "Department"],
    "cat": ["CategoryShortName", "CategoryName", "Category"],
    "date": ["XnDt", "InvoiceDt", "CashmemoDt", "XnMemoDate", "SaleDate"],
}
_ENV_ROLE = {
    "amount": "SALES_ANALYTICS_AMOUNT_COLUMN",
    "qty": "SALES_ANALYTICS_QTY_COLUMN",
    "invoice": "SALES_ANALYTICS_INVOICE_COLUMN",
    "customer": "SALES_ANALYTICS_CUSTOMER_COLUMN",
    "branch": "SALES_ANALYTICS_BRANCH_DIM",
    "dept": "SALES_ANALYTICS_DEPARTMENT_DIM",
    "cat": "SALES_ANALYTICS_CATEGORY_DIM",
}

# Avoid 5+ simultaneous ODBC queries (dashboard felt slower than Node).
_query_sem = asyncio.Semaphore(3)
_kpi_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_analytics_cache: dict[str, tuple[float, Any]] = {}
_KPI_CACHE_TTL = 90.0
_ANALYTICS_CACHE_TTL = 90.0

_IDENT_OK = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,127}$")

# Normalized view name (no dbo., upper, underscores) → (MB filter prefix, default date col)
# Matches datasets-registry.js defaultDateColumn for analytics views.
_REGISTRY_DATE: dict[str, tuple[str, str]] = {
    "VW_MB_POWERBI_APP_REPORT": ("MB_POWERBI_APP_REPORT", "XnDt"),
    "VW_MB_POWERBI_SLS_REPORT": ("MB_POWERBI_SLS_REPORT", "XnMemoDate"),
    "VW_MB_POWERBI_SLSXNS_REPORT": ("MB_POWERBI_SLSXNS_REPORT", "XnDt"),
    "VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID": ("MB_POWERBI_SLS_DATA_WITHOUT_ITEMID", "CashmemoDt"),
    "VW_MB_POWERBI_SLS_BILLCOUNT": ("MB_POWERBI_SLS_BILLCOUNT", "CashmemoDt"),
    "VW_MB_POWERBI_SLS_ARTICLE_REPORT": ("MB_POWERBI_SLS_ARTICLE_REPORT", "XnMemoDate"),
}


# ── Helpers ───────────────────────────────────────────────────────────────────
def _sanitize_sql_ident(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    return s if _IDENT_OK.match(s) else None


def _nolock(sql: str) -> str:
    if not rc.get_bool("ANALYTICS_NOLOCK", True):
        return sql
    # Templates already use WITH (NOLOCK); regex can corrupt edge cases — skip.
    if re.search(r"\bWITH\s*\(\s*NOLOCK\s*\)", sql, re.I):
        return sql
    return re.sub(
        r"\bFROM\s+([\w.\[\]]+)(?!\s+WITH\s*\(NOLOCK\))",
        r"FROM \1 WITH (NOLOCK)",
        sql,
    )


def _base_table() -> str:
    """Prefer .env ANALYTICS_BASE_TABLE — Node default is SLS_REPORT (much faster than line-level SLSXNS)."""
    env_tbl = (os.getenv("ANALYTICS_BASE_TABLE") or "").strip()
    if env_tbl:
        return env_tbl
    return str(rc.get("ANALYTICS_BASE_TABLE", "dbo.VW_MB_POWERBI_SLS_REPORT")).strip()


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


def _pick_column(role: str, view_cols: set[str], fallback: Optional[str], table: str = "") -> Optional[str]:
    env_key = _ENV_ROLE.get(role)
    if env_key:
        ev = _sanitize_sql_ident(str(rc.get(env_key, "") or os.getenv(env_key, "") or "").strip() or None)
        u = (table or _base_table()).upper()
        if role == "amount" and ev == "NetSlsNetAmount" and "SLS_REPORT" in u and "SLSXNS" not in u:
            ev = None
        if ev and (not view_cols or ev in view_cols):
            return ev
    for name in _ROLE_CANDIDATES.get(role, []):
        if view_cols:
            if name in view_cols:
                return name
        else:
            return name
    return fallback if not view_cols else None


def _resolve_columns(table: str) -> dict[str, str]:
    view_cols = _view_columns(table)
    dc = _resolve_date_col(table)
    return {
        "amt": _pick_column("amount", view_cols, "NetAmount", table),
        "dc": dc,
        "inv": _pick_column("invoice", view_cols, _infer_invoice_col(table), table),
        "qty": _pick_column("qty", view_cols, "NetSlsQty", table),
        "cust": _pick_column("customer", view_cols, "XnId", table),
        "branch": _pick_column("branch", view_cols, "BranchAlias", table),
        "dept": _pick_column("dept", view_cols, "DepartmentShortName", table),
        "cat": _pick_column("cat", view_cols, "CategoryShortName", table),
    }


def _period_span_days(period: str) -> int:
    return {
        "today": 1, "yesterday": 1, "last7": 7, "last30": 30, "last_30d": 30,
        "mtd": 31, "qtd": 92, "ytd": 365, "6m": 180, "last_6m": 180,
    }.get(period, 30)


def _query_hint(period: str) -> str:
    if not rc.get_bool("ANALYTICS_RECOMPILE", True):
        return ""
    threshold = rc.get_int("ANALYTICS_RECOMPILE_THRESHOLD", 30)
    if _period_span_days(period) > threshold:
        return " OPTION (RECOMPILE)"
    return ""


def _step_timeout_s() -> float:
    return min(rc.get_int("DB_REQUEST_TIMEOUT_MS", 120000) / 1000, 100.0)


def _table_base_for_env(effective_table: str) -> str:
    t = (effective_table or "").strip()
    if t[:4].lower() == "dbo.":
        t = t[4:]
    return re.sub(r"[.\s-]+", "_", t.upper())


def _resolve_date_col(table: str) -> str:
    """Match Node resolveAnalyticsDateCol: per-table env → prefix env → catalog default; global SALES_FILTER_DATE_COLUMN only if table unknown."""
    base = _table_base_for_env(table)
    if base:
        ev = _sanitize_sql_ident((os.getenv(f"{base}_FILTER_DATE_COLUMN") or "").strip() or None)
        if ev:
            return ev
    reg = _REGISTRY_DATE.get(base)
    if reg:
        prefix, default_d = reg
        ev2 = _sanitize_sql_ident((os.getenv(f"{prefix}_FILTER_DATE_COLUMN") or "").strip() or None)
        if ev2:
            return ev2
        # Known analytics view: use same default as datasets-registry / schema (Node ignores global
        # SALES_FILTER_DATE_COLUMN when the view exposes a canonical date column).
        return default_d
    gv = _sanitize_sql_ident(str(rc.get("SALES_FILTER_DATE_COLUMN", "") or "").strip() or None)
    if gv:
        return gv
    return "XnDt"


def _amount_col() -> str:
    v = _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_AMOUNT_COLUMN", "") or "").strip() or None)
    return v or "NetSlsNetAmount"


def _branch_dim() -> str:
    return _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_BRANCH_DIM", "") or "").strip() or None) or "BranchAlias"


def _dept_dim() -> str:
    return (
        _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_DEPARTMENT_DIM", "") or "").strip() or None)
        or "DepartmentShortName"
    )


def _cat_dim() -> str:
    return (
        _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_CATEGORY_DIM", "") or "").strip() or None)
        or "CategoryShortName"
    )


def _infer_invoice_col(table: str) -> Optional[str]:
    """Only used when metadata snapshot is missing — never guess InvoiceNo on SLS_REPORT."""
    u = table.upper()
    if "SLSXNS" in u or "XNS" in u:
        return "XnNo"
    return None


def _invoice_col(table: str) -> str:
    explicit = str(rc.get("SALES_ANALYTICS_INVOICE_COLUMN", "") or "").strip()
    if explicit:
        ok = _sanitize_sql_ident(explicit)
        if ok:
            return ok
    return _infer_invoice_col(table)


def _is_slsxns_xndt(table: str, dc: str) -> bool:
    return "SLSXNS" in table.upper() and dc.lower() == "xndt"


def _where_today_server(table: str, dc: str) -> str:
    """Same-day filter using SQL Server calendar (matches Node /api/home/kpi)."""
    d = f"[{dc}]"
    if _is_slsxns_xndt(table, dc):
        return f"{d} = CAST(GETDATE() AS DATE)"
    return f"CAST({d} AS DATE) = CAST(GETDATE() AS DATE)"


def _where_mtd(dc: str) -> str:
    return (
        f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, 1 - DAY(GETDATE()), CAST(GETDATE() AS DATE)) AS DATE) "
        f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
    )


def _where_yesterday_server(table: str, dc: str) -> str:
    d = f"[{dc}]"
    if _is_slsxns_xndt(table, dc):
        return f"{d} = DATEADD(day, -1, CAST(GETDATE() AS DATE))"
    return f"CAST({d} AS DATE) = DATEADD(day, -1, CAST(GETDATE() AS DATE))"


def _fiscal_year_start() -> str:
    """Returns start of current Indian FY (April 1)."""
    now = datetime.utcnow()
    if now.month >= 4:
        return f"{now.year}-04-01"
    return f"{now.year - 1}-04-01"


def _quarter_start() -> str:
    now = datetime.utcnow()
    month = now.month
    if 4 <= month <= 6:
        return f"{now.year}-04-01"
    if 7 <= month <= 9:
        return f"{now.year}-07-01"
    if 10 <= month <= 12:
        return f"{now.year}-10-01"
    return f"{now.year - 1}-01-01"


async def _run(sql: str) -> list[dict]:
    timeout_s = rc.get_int("DB_REQUEST_TIMEOUT_MS", 120000) / 1000
    async with _query_sem:
        return await asyncio.wait_for(execute_query(_nolock(sql)), timeout=timeout_s)


def _sales_ctx() -> dict[str, str]:
    tbl = _base_table()
    cols = _resolve_columns(tbl)
    return {"tbl": tbl, **cols}


def _qty_col() -> str:
    return _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_QTY_COLUMN", "") or "").strip() or None) or "NetSlsQty"


def _customer_col() -> str:
    return _sanitize_sql_ident(str(rc.get("SALES_ANALYTICS_CUSTOMER_COLUMN", "") or "").strip() or None) or "XnId"


def _period_where(period: str, tbl: str, dc: str) -> str:
    if period == "today":
        return _where_today_server(tbl, dc)
    if period == "yesterday":
        return _where_yesterday_server(tbl, dc)
    if period in ("mtd",):
        return _where_mtd(dc)
    if period in ("6m", "last_6m"):
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(month, -6, GETDATE()) AS DATE)"
    if period in ("last_30d", "last30"):
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -30, GETDATE()) AS DATE)"
    if period in ("last_60d", "last60"):
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -60, GETDATE()) AS DATE)"
    if period in ("last_90d", "last90"):
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -90, GETDATE()) AS DATE)"
    if period in ("last_180d", "last180"):
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -180, GETDATE()) AS DATE)"
    if period == "qtd":
        qs = _quarter_start()
        return (
            f"CAST([{dc}] AS DATE) >= CAST('{qs}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
        )
    if period == "ytd":
        fy = _fiscal_year_start()
        return (
            f"CAST([{dc}] AS DATE) >= CAST('{fy}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
        )
    if period == "last7":
        return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -7, GETDATE()) AS DATE)"
    return f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -30, GETDATE()) AS DATE)"


def _period_kpi_to_slice(row: dict) -> dict:
    return {
        "sales": float(row.get("totalSales") or 0),
        "bills": int(row.get("billCount") or 0),
        "quantitySold": float(row.get("quantitySold") or 0),
        "customerCount": int(row.get("customerCount") or 0),
    }


async def _fetch_kpi_summary_cached(period: str) -> dict:
    now = time.time()
    hit = _kpi_cache.get(period)
    if hit and (now - hit[0]) < _KPI_CACHE_TTL:
        return hit[1]
    data = await _fetch_kpi_summary(period)
    _kpi_cache[period] = (now, data)
    return data


def _bill_count_expr(tbl: str, inv: Optional[str]) -> str:
    """SLSXNS+BillCount: SUM; invoice col: DISTINCT; else COUNT(*) like Node row_cnt on rollups."""
    u = (tbl or "").upper()
    if inv and "SLSXNS" in u and inv == "BillCount":
        return "CAST(SUM(ISNULL([BillCount], 0)) AS BIGINT)"
    if inv:
        return f"COUNT(DISTINCT [{inv}])"
    return "COUNT(*)"


def _bills_agg_expr(tbl: str, inv: Optional[str]) -> str:
    return _bill_count_expr(tbl, inv)


def _customer_count_expr(cust: Optional[str]) -> str:
    if cust:
        return f"COUNT(DISTINCT [{cust}])"
    return "CAST(NULL AS BIGINT)"


async def _cached_analytics(key: str, factory):
    now = time.time()
    hit = _analytics_cache.get(key)
    if hit and (now - hit[0]) < _ANALYTICS_CACHE_TTL:
        return hit[1]
    val = await factory()
    _analytics_cache[key] = (now, val)
    return val


def _normalize_period_rows(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        out.append({
            "label": r.get("label") or r.get("Label") or "",
            "value": float(r.get("value") or r.get("Value") or 0),
            "bills": int(r.get("bills") or r.get("Bills") or 0),
        })
    return out


async def _fetch_kpi_summary(period: str) -> dict:
    """Single-period KPI row (matches Node GET /api/home/kpi fields)."""
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    qty = ctx["qty"] or _qty_col()
    cust = ctx["cust"]
    where = _period_where(period, tbl, dc)
    bills_sql = _bill_count_expr(tbl, inv)
    cust_sql = _customer_count_expr(cust)
    sql = f"""
    SELECT
      ISNULL(SUM([{amt}]), 0) AS total_sales,
      {bills_sql} AS bill_count,
      ISNULL(SUM([{qty}]), 0) AS quantity_sold,
      {cust_sql} AS customer_count
    FROM {tbl} WITH (NOLOCK)
    WHERE {where}
    """
    rows = await _run(sql)
    row = rows[0] if rows else {}
    bills = int(row.get("bill_count") or 0)
    sales = float(row.get("total_sales") or 0)
    return {
        "period": period,
        "totalSales": sales,
        "billCount": bills,
        "txnCount": bills,
        "quantitySold": float(row.get("quantity_sold") or 0),
        "customerCount": int(row.get("customer_count") or 0),
    }


async def _fetch_home_kpis() -> dict:
    """Today first, then MTD — same as Node /api/home/kpi (two light queries, not one heavy CASE scan)."""
    today_row = await _fetch_kpi_summary_cached("today")
    mtd_row = await _fetch_kpi_summary_cached("mtd")
    return {
        "today": _period_kpi_to_slice(today_row),
        "mtd": _period_kpi_to_slice(mtd_row),
        "asOf": datetime.utcnow().isoformat(),
    }


@dataclass
class AnalyticsFilters:
    period: str
    range: dict[str, str]
    cross_filter: dict[str, str]
    trend_month: str
    trend_grain: str
    fy_label: Optional[str] = None
    fy_note: Optional[str] = None


def resolve_analytics_filters(
    period: str,
    fy: str = "",
    custom_from: str = "",
    custom_to: str = "",
    cross_filter_raw: Optional[str] = None,
    trend_month: str = "",
    trend_grain: str = "auto",
) -> AnalyticsFilters:
    chip = period_chip_range(period, custom_from, custom_to)
    rng, fy_label, note = intersect_range(chip, fy)
    return AnalyticsFilters(
        period=period,
        range={"from": rng["from"], "to": rng["to"]},
        cross_filter=parse_cross_filter_json(cross_filter_raw),
        trend_month=(trend_month or "").strip(),
        trend_grain=(trend_grain or "auto").strip().lower(),
        fy_label=fy_label,
        fy_note=note,
    )


def _filter_cache_key(flt: AnalyticsFilters, suffix: str = "") -> str:
    cf = json.dumps(flt.cross_filter, sort_keys=True)
    return f"{flt.period}:{flt.range['from']}:{flt.range['to']}:{cf}:{flt.trend_month}:{flt.trend_grain}:{suffix}:{_base_table()}"


def _compose_where(ctx: dict[str, str], flt: AnalyticsFilters) -> str:
    dc = ctx["dc"]
    base = range_to_where(dc, flt.range, flt.trend_month)
    cf = cross_filter_clause(
        flt.cross_filter,
        [ctx["branch"], ctx["dept"], ctx["cat"]],
    )
    return base + cf


async def _fetch_kpi_filtered(flt: AnalyticsFilters) -> dict:
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    qty = ctx["qty"] or _qty_col()
    where = _compose_where(ctx, flt)
    bills_sql = _bill_count_expr(tbl, inv)
    cust_sql = _customer_count_expr(ctx["cust"])
    sql = f"""
    SELECT
      ISNULL(SUM([{amt}]), 0) AS total_sales,
      {bills_sql} AS bill_count,
      ISNULL(SUM([{qty}]), 0) AS quantity_sold,
      {cust_sql} AS customer_count
    FROM {tbl} WITH (NOLOCK)
    WHERE {where}
    """
    rows = await _run(sql)
    row = rows[0] if rows else {}
    return {
        "period": flt.period,
        "totalSales": float(row.get("total_sales") or 0),
        "billCount": int(row.get("bill_count") or 0),
        "txnCount": int(row.get("bill_count") or 0),
        "quantitySold": float(row.get("quantity_sold") or 0),
        "customerCount": int(row.get("customer_count") or 0),
    }


async def _fetch_period_filtered(flt: AnalyticsFilters, dimension: str, top: int = 10) -> dict:
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    dim_col = {
        "branch": ctx["branch"],
        "department": ctx["dept"],
        "category": ctx["cat"],
    }.get(dimension, ctx["branch"])
    where = _compose_where(ctx, flt)
    top = max(5, min(30, top))
    bills_sql = _bills_agg_expr(tbl, inv)
    hint = _query_hint(flt.period)
    sql = f"""
    SELECT TOP {top} [{dim_col}] AS label,
           SUM([{amt}]) AS value,
           {bills_sql} AS bills
    FROM {tbl} WITH (NOLOCK)
    WHERE {where}
      AND [{dim_col}] IS NOT NULL AND CAST([{dim_col}] AS NVARCHAR(500)) <> ''
    GROUP BY [{dim_col}]
    ORDER BY value DESC{hint}
    """
    rows = await _run(sql)
    return {
        "data": _normalize_period_rows(rows),
        "period": flt.period,
        "dimension": dimension,
        "rowCount": len(rows),
    }


async def _fetch_trend_filtered(flt: AnalyticsFilters) -> dict:
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    where = _compose_where(ctx, flt)
    d0 = datetime.strptime(flt.range["from"][:10], "%Y-%m-%d").date()
    d1 = datetime.strptime(flt.range["to"][:10], "%Y-%m-%d").date()
    days = max(1, (d1 - d0).days + 1)
    use_month = flt.trend_grain == "month" or (flt.trend_grain == "auto" and days > 62)
    bills_sql = _bills_agg_expr(tbl, inv)
    hint = _query_hint(flt.period)
    if use_month:
        sql = f"""
        SELECT
          CONCAT(YEAR(CAST([{dc}] AS DATE)), '-',
            RIGHT('0' + CAST(MONTH(CAST([{dc}] AS DATE)) AS varchar(2)), 2)) AS day,
          SUM([{amt}]) AS value,
          {bills_sql} AS bills
        FROM {tbl} WITH (NOLOCK)
        WHERE {where}
        GROUP BY YEAR(CAST([{dc}] AS DATE)), MONTH(CAST([{dc}] AS DATE))
        ORDER BY YEAR(CAST([{dc}] AS DATE)), MONTH(CAST([{dc}] AS DATE)){hint}
        """
        granularity = "month"
    else:
        sql = f"""
        SELECT CAST([{dc}] AS DATE) AS day,
               SUM([{amt}]) AS value,
               {bills_sql} AS bills
        FROM {tbl} WITH (NOLOCK)
        WHERE {where}
        GROUP BY CAST([{dc}] AS DATE)
        ORDER BY day ASC{hint}
        """
        granularity = "day"
    rows = await _run(sql)
    out = []
    for r in rows:
        d = r.get("day") or r.get("Day")
        if isinstance(d, (date, datetime)):
            d = d.isoformat()[:7] if use_month and isinstance(d, date) else d.isoformat()
        out.append({
            "day": str(d),
            "value": float(r.get("value") or r.get("Value") or 0),
            "bills": int(r.get("bills") or r.get("Bills") or 0),
        })
    return {"data": out, "days": days, "granularity": granularity}


async def _fetch_period(period: str, dimension: str, top: int = 10) -> dict:
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    dim_col = {
        "branch": ctx["branch"],
        "department": ctx["dept"],
        "category": ctx["cat"],
    }.get(dimension, ctx["branch"])
    where = _period_where(period, tbl, dc)
    top = max(5, min(30, top))
    bills_sql = _bills_agg_expr(tbl, inv)
    hint = _query_hint(period)
    sql = f"""
    SELECT TOP {top} [{dim_col}] AS label,
           SUM([{amt}]) AS value,
           {bills_sql} AS bills
    FROM {tbl} WITH (NOLOCK)
    WHERE {where}
      AND [{dim_col}] IS NOT NULL AND CAST([{dim_col}] AS NVARCHAR(500)) <> ''
    GROUP BY [{dim_col}]
    ORDER BY value DESC{hint}
    """
    rows = await _run(sql)
    return {
        "data": _normalize_period_rows(rows),
        "period": period,
        "dimension": dimension,
        "rowCount": len(rows),
    }


async def _fetch_trend(days: int) -> dict:
    """Legacy: last N calendar days."""
    ctx = _sales_ctx()
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    days = max(7, min(90, days))
    bills_sql = _bills_agg_expr(tbl, inv)
    where = f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, -{days}, GETDATE()) AS DATE)"
    return await _fetch_trend_where(ctx, where, days)


async def _fetch_trend_for_period(period: str) -> dict:
    """Trend for the same date window as the period chip (MTD → days in month only)."""
    ctx = _sales_ctx()
    tbl, dc = ctx["tbl"], ctx["dc"]
    where = _period_where(period, tbl, dc)
    days = _period_span_days(period)
    return await _fetch_trend_where(ctx, where, days, period)


async def _fetch_trend_where(
    ctx: dict[str, str],
    where: str,
    days: int,
    period: Optional[str] = None,
) -> dict:
    tbl, amt, dc, inv = ctx["tbl"], ctx["amt"], ctx["dc"], ctx["inv"]
    bills_sql = _bills_agg_expr(tbl, inv)
    hint = _query_hint(period or "last30")
    sql = f"""
    SELECT CAST([{dc}] AS DATE) AS day,
           SUM([{amt}]) AS value,
           {bills_sql} AS bills
    FROM {tbl} WITH (NOLOCK)
    WHERE {where}
    GROUP BY CAST([{dc}] AS DATE)
    ORDER BY day ASC{hint}
    """
    rows = await _run(sql)
    out = []
    for r in rows:
        d = r.get("day") or r.get("Day")
        if isinstance(d, (date, datetime)):
            d = d.isoformat()
        out.append({
            "day": d,
            "value": float(r.get("value") or r.get("Value") or 0),
            "bills": int(r.get("bills") or r.get("Bills") or 0),
        })
    return {"data": out, "days": days}


def _where_mtd_yoy(dc: str) -> str:
    """Scan only current month + same calendar month last year (faster than open-ended OR)."""
    d = f"CAST([{dc}] AS DATE)"
    return (
        f"({d} >= CAST(DATEADD(day, 1 - DAY(GETDATE()), CAST(GETDATE() AS DATE)) AS DATE) AND {d} <= CAST(GETDATE() AS DATE)) "
        f"OR ({d} >= CAST(DATEADD(month, -12, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS DATE) "
        f"AND {d} < CAST(DATEADD(month, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS DATE))"
    )


async def _fetch_yoy(period: str = "mtd") -> dict:
    ctx = _sales_ctx()
    tbl, amt, dc = ctx["tbl"], ctx["amt"], ctx["dc"]
    if period == "mtd":
        cy_where = (
            f"CAST([{dc}] AS DATE) >= CAST(DATEADD(day, 1 - DAY(GETDATE()), CAST(GETDATE() AS DATE)) AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
        )
        ly_where = (
            f"CAST([{dc}] AS DATE) >= CAST(DATEADD(month, -12, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS DATE) "
            f"AND CAST([{dc}] AS DATE) < CAST(DATEADD(month, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)) AS DATE)"
        )
        scan = _where_mtd_yoy(dc)
    elif period == "qtd":
        qs = _quarter_start()
        today = datetime.utcnow()
        ly_qs = (datetime.strptime(qs, "%Y-%m-%d") - timedelta(days=365)).strftime("%Y-%m-%d")
        ly_to = (today - timedelta(days=365)).strftime("%Y-%m-%d")
        cy_where = (
            f"CAST([{dc}] AS DATE) >= CAST('{qs}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
        )
        ly_where = (
            f"CAST([{dc}] AS DATE) >= CAST('{ly_qs}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST('{ly_to}' AS DATE)"
        )
        scan = f"({cy_where}) OR ({ly_where})"
    elif period == "ytd":
        fy_cy = _fiscal_year_start()
        today = datetime.utcnow()
        fy_ly = (datetime.strptime(fy_cy, "%Y-%m-%d") - timedelta(days=365)).strftime("%Y-%m-%d")
        ly_to = (today - timedelta(days=365)).strftime("%Y-%m-%d")
        cy_where = (
            f"CAST([{dc}] AS DATE) >= CAST('{fy_cy}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST(GETDATE() AS DATE)"
        )
        ly_where = (
            f"CAST([{dc}] AS DATE) >= CAST('{fy_ly}' AS DATE) "
            f"AND CAST([{dc}] AS DATE) <= CAST('{ly_to}' AS DATE)"
        )
        scan = f"({cy_where}) OR ({ly_where})"
    else:
        return {"cy": 0, "ly": 0, "change": 0, "period": period, "supported": False}

    sql = f"""
    SELECT
      SUM(CASE WHEN {cy_where} THEN [{amt}] ELSE 0 END) AS CY,
      SUM(CASE WHEN {ly_where} THEN [{amt}] ELSE 0 END) AS LY
    FROM {tbl} WITH (NOLOCK)
    WHERE {scan}
    """
    rows = await _run(sql)
    if rows:
        cy = float(rows[0].get("CY") or 0)
        ly = float(rows[0].get("LY") or 0)
        change = round(((cy - ly) / ly * 100) if ly else 0, 2)
        return {"cy": cy, "ly": ly, "change": change, "period": period, "supported": True}
    return {"cy": 0, "ly": 0, "change": 0, "period": period, "supported": True}


def _period_description(period: str) -> str:
    labels = {
        "today": "Today's sales by branch, department, and category.",
        "yesterday": "Yesterday's sales by branch, department, and category.",
        "mtd": "Month-to-date: daily trend plus top branch, department, and category. Compared with the same month last year.",
        "qtd": "Current quarter (~3 months): daily trend plus breakdowns. Compared with the same quarter last year.",
        "ytd": "Fiscal year-to-date (Apr–Mar): daily trend plus breakdowns. Compared with prior fiscal year-to-date.",
        "last7": "Last 7 days: daily trend and breakdowns.",
        "last30": "Last 30 days: daily trend and breakdowns.",
        "last_30d": "Rolling 30 days: trend and breakdowns.",
        "last_90d": "Rolling 90 days: trend (monthly when auto) and breakdowns.",
        "6m": "Last 6 months: monthly/daily trend and breakdowns.",
        "last_6m": "Last 6 months: trend and breakdowns.",
        "last_180d": "Last 180 days: trend and breakdowns.",
        "custom": "Custom date range — set from/to then Apply range.",
    }
    return labels.get(period, "Sales analytics for the selected period.")


def _yoy_supports(period: str) -> bool:
    return period in ("mtd", "qtd", "ytd")


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/kpi")
async def kpi_for_period(
    period: str = Query("mtd"),
    current_user: dict = Depends(get_current_user),
):
    """Period KPI summary — same shape as Node GET /api/home/kpi."""
    try:
        return await _fetch_kpi_summary_cached(period)
    except Exception as e:
        return {"error": str(e), "period": period, "ok": False}


@router.get("/home-bundle")
async def home_bundle(
    period: str = Query("mtd"),
    trend_days: int = Query(30, ge=7, le=90),
    top: int = Query(10, ge=5, le=50),
    include_yoy: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    """
    One round-trip for the dashboard: KPIs + charts in parallel on the server.
    YoY is optional (slow on large fact tables).
    """
    # KPIs are loaded via /home-kpis (single query) so the UI can paint before these heavier aggregates.
    p = period if period in (
        "today", "yesterday", "mtd", "qtd", "ytd", "last7", "last30",
        "6m", "last_6m", "last_30d", "last_60d", "last_90d", "last_180d",
    ) else "mtd"
    # Run sequentially so KPI / other requests are not blocked behind 4 parallel scans.
    keys = ["branch", "department", "category", "trend"]
    tasks: list = [
        ("branch", _fetch_period(p, "branch", top)),
        ("department", _fetch_period(p, "department", top)),
        ("category", _fetch_period(p, "category", top)),
        ("trend", _fetch_trend(trend_days)),
    ]
    results: list = []
    for _key, coro in tasks:
        try:
            results.append(await coro)
        except Exception as e:
            results.append(e)
    if include_yoy:
        keys.append("yoy")
        try:
            results.append(await _fetch_yoy("mtd"))
        except Exception as e:
            results.append(e)
    out: dict = {"asOf": datetime.utcnow().isoformat()}
    errors: list[str] = []
    for key, res in zip(keys, results):
        if isinstance(res, Exception):
            errors.append(f"{key}: {res}")
            out[key] = None
        else:
            out[key] = res
    if errors:
        out["errors"] = errors
    return out


@router.get("/home-kpis")
async def home_kpis(current_user: dict = Depends(get_current_user)):
    """Today + MTD sales figures for the dashboard home tiles."""
    try:
        return await _fetch_home_kpis()
    except Exception as e:
        return {"error": str(e)}


@router.get("/page-bundle")
async def analytics_page_bundle(
    period: str = Query("mtd"),
    dimension: str = Query("branch", enum=["branch", "department", "category"]),
    trend_days: int = Query(30, ge=7, le=90),
    top: int = Query(10, ge=5, le=30),
    include_yoy: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    """
    Analytics tab bundle — sequential SQL with per-step timeout (partial results on slow MTD).
    """
    del current_user
    p = period if period in (
        "today", "yesterday", "mtd", "qtd", "ytd", "last7", "last30",
        "6m", "last_6m", "last_30d", "last_60d", "last_90d", "last_180d",
    ) else "mtd"
    cache_key = f"page:{p}:{dimension}:{top}:{include_yoy}:{_base_table()}"
    out: dict[str, Any] = {
        "period": p,
        "dimension": dimension,
        "table": _base_table(),
        "asOf": datetime.utcnow().isoformat(),
    }
    errors: list[str] = []
    step_t = _step_timeout_s()

    async def build():
        nonlocal errors
        try:
            out["breakdown"] = await asyncio.wait_for(
                _cached_analytics(
                    f"period:{p}:{dimension}:{top}:{_base_table()}",
                    lambda: _fetch_period(p, dimension, top),
                ),
                timeout=step_t,
            )
        except Exception as e:
            errors.append(f"breakdown: {e}")
            out["breakdown"] = {"data": [], "error": str(e), "period": p, "dimension": dimension}
        try:
            out["trend"] = await asyncio.wait_for(
                _cached_analytics(
                    f"trend:{p}:{_base_table()}",
                    lambda: _fetch_trend_for_period(p),
                ),
                timeout=step_t,
            )
        except Exception as e:
            errors.append(f"trend: {e}")
            out["trend"] = {"data": [], "error": str(e), "days": _period_span_days(p)}
        if include_yoy and _yoy_supports(p):
            try:
                out["yoy"] = await asyncio.wait_for(
                    _cached_analytics(f"yoy:{p}:{_base_table()}", lambda: _fetch_yoy(p)),
                    timeout=step_t,
                )
            except Exception as e:
                errors.append(f"yoy: {e}")
                out["yoy"] = {"cy": 0, "ly": 0, "change": 0, "error": str(e)}
        if errors:
            out["errors"] = errors
        return out

    hit = _analytics_cache.get(cache_key)
    now = time.time()
    if hit and (now - hit[0]) < _ANALYTICS_CACHE_TTL:
        return hit[1]
    result = await build()
    _analytics_cache[cache_key] = (now, result)
    return result


_VALID_PERIODS = frozenset({
    "today", "yesterday", "mtd", "qtd", "ytd", "last7", "last30",
    "6m", "last_6m", "last_30d", "last_60d", "last_90d", "last_180d", "custom",
})


@router.post("/invalidate-cache")
async def invalidate_analytics_cache(current_user: dict = Depends(get_current_user)):
    """Clear in-memory analytics caches (Node: POST /api/analytics/invalidate-cache)."""
    del current_user
    _analytics_cache.clear()
    _kpi_cache.clear()
    return {"ok": True, "cleared": True}


@router.get("/snapshot")
async def analytics_snapshot(
    period: str = Query("mtd"),
    top: int = Query(8, ge=5, le=15),
    load_phase: str = Query("full", enum=["critical", "widgets", "full"]),
    fy: str = Query(""),
    custom_from: str = Query(""),
    custom_to: str = Query(""),
    cross_filter: str = Query(""),
    trend_month: str = Query(""),
    trend_grain: str = Query("auto"),
    current_user: dict = Depends(get_current_user),
):
    """
    Analytics Engine payload — phased like Node dashboard (critical → widgets).
    Supports FY clip, cross-filter, custom range, trend month/grain.
    """
    del current_user
    p = period if period in _VALID_PERIODS else "mtd"
    flt = resolve_analytics_filters(
        p, fy, custom_from, custom_to, cross_filter, trend_month, trend_grain
    )
    cache_key = f"snapshot:{load_phase}:{_filter_cache_key(flt, str(top))}"
    step_t = _step_timeout_s()

    async def build() -> dict[str, Any]:
        out: dict[str, Any] = {
            "period": p,
            "periodRange": flt.range,
            "description": _period_description(p),
            "table": _base_table(),
            "asOf": datetime.utcnow().isoformat(),
            "yoySupported": _yoy_supports(p),
            "fyLabel": flt.fy_label,
            "fyNote": flt.fy_note,
            "crossFilter": flt.cross_filter,
            "loadPhase": load_phase,
            "dimensions": {
                "branch": _sales_ctx()["branch"],
                "department": _sales_ctx()["dept"],
                "category": _sales_ctx()["cat"],
            },
        }
        errors: list[str] = []

        async def step(key: str, factory):
            try:
                return await asyncio.wait_for(factory(), timeout=step_t)
            except Exception as e:
                errors.append(f"{key}: {e}")
                return None

        if load_phase in ("critical", "full"):
            kpi = await step(
                "kpi",
                lambda: _cached_analytics(
                    _filter_cache_key(flt, "kpi"),
                    lambda: _fetch_kpi_filtered(flt),
                ),
            )
            out["kpi"] = kpi or {"period": p, "totalSales": 0, "billCount": 0}
            trend = await step(
                "trend",
                lambda: _cached_analytics(
                    _filter_cache_key(flt, "trend"),
                    lambda: _fetch_trend_filtered(flt),
                ),
            )
            out["trend"] = trend or {"data": [], "days": 0, "granularity": "day"}

        if load_phase in ("widgets", "full"):
            for dim in ("branch", "department", "category"):
                blk = await step(
                    dim,
                    lambda d=dim: _cached_analytics(
                        _filter_cache_key(flt, d),
                        lambda: _fetch_period_filtered(flt, d, top),
                    ),
                )
                out[dim] = blk or {"data": [], "period": p, "dimension": dim}
            if _yoy_supports(p) and not flt.cross_filter:
                yoy = await step(
                    "yoy",
                    lambda: _cached_analytics(
                        _filter_cache_key(flt, "yoy"),
                        lambda: _fetch_yoy(p),
                    ),
                )
                out["yoy"] = yoy or {"cy": 0, "ly": 0, "change": 0, "period": p}

        if errors:
            out["errors"] = errors
        return out

    hit = _analytics_cache.get(cache_key)
    now = time.time()
    if hit and (now - hit[0]) < _ANALYTICS_CACHE_TTL:
        return hit[1]
    result = await build()
    _analytics_cache[cache_key] = (now, result)
    return result


@router.get("/period")
async def period_report(
    period: str = Query("mtd", enum=["today", "yesterday", "mtd", "qtd", "ytd", "last7", "last30"]),
    dimension: str = Query("branch", enum=["branch", "department", "category"]),
    top: int = Query(10, ge=5, le=30),
    current_user: dict = Depends(get_current_user),
):
    """Sales breakdown by period and dimension."""
    del current_user
    try:
        return await _cached_analytics(
            f"period:{period}:{dimension}:{top}",
            lambda: _fetch_period(period, dimension, top),
        )
    except Exception as e:
        return {"data": [], "error": str(e)}


@router.get("/trend")
async def trend_report(
    days: int = Query(30, ge=7, le=90),
    period: Optional[str] = Query(None),
    dimension: str = Query("branch"),
    current_user: dict = Depends(get_current_user),
):
    """Daily trend — pass period=mtd to match the selected chip, or days= for rolling window."""
    del current_user, dimension
    try:
        if period:
            p = period if period in (
                "today", "yesterday", "mtd", "qtd", "ytd", "last7", "last30",
                "6m", "last_6m", "last_30d",
            ) else "mtd"
            return await _cached_analytics(
                f"trend:{p}:{_base_table()}",
                lambda: _fetch_trend_for_period(p),
            )
        return await _cached_analytics(f"trend:{days}", lambda: _fetch_trend(days))
    except Exception as e:
        return {"data": [], "error": str(e)}


@router.get("/yoy")
async def yoy_comparison(
    period: str = Query("mtd"),
    current_user: dict = Depends(get_current_user),
):
    """Year-on-year comparison for a period."""
    del current_user
    try:
        return await _cached_analytics(f"yoy:{period}", lambda: _fetch_yoy(period))
    except Exception as e:
        return {"cy": 0, "ly": 0, "change": 0, "error": str(e)}


@router.get("/test-db")
async def test_db(current_user: dict = Depends(get_current_user)):
    """Ping the ERP SQL Server."""
    from ..services.db_mssql import test_connection

    ok = await test_connection()
    return {"ok": ok}
