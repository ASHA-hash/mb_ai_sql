"""
Runtime configuration store.
PostgreSQL primary (erp_runtime_config table), .env fallback.
Mirrors services/runtime-config.js behaviour.
"""
import os
import asyncio
from typing import Any, Optional
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict[str, str] = {}
_loaded = False

# ── Defaults (fallback when neither PG nor .env has a value) ─────────────────
_DEFAULTS: dict[str, str] = {
    "OPENAI_MODEL":                       "gpt-4o-mini",
    "ANTHROPIC_MODEL":                    "claude-sonnet-4-6",
    "NLQ_FAST_PATH":                      "1",
    "NLQ_INTENT_COMPILER":                "1",
    "ADAPTIVE_INTENT_STEP":               "1",
    "COGNITIVE_COLUMN_DISCOVERY":         "1",
    "AI_ADAPTIVE_SUMMARY":                "1",
    "AI_SCHEMA_MAX_TABLES":               "14",
    "DATASET_HARD_CAP":                   "20000",
    "DATASET_PAGE_MAX":                   "1000",
    "DB_POOL_MAX":                        "10",
    "DB_REQUEST_TIMEOUT_MS":              "120000",
    "DB_CONNECT_TIMEOUT_MS":              "60000",
    "ANALYTICS_CACHE_TTL_MS":             "600000",
    "ANALYTICS_NOLOCK":                   "1",
    "SALES_AI_TABLE":                     "dbo.VW_MB_POWERBI_SLS_REPORT",
    "ANALYTICS_BASE_TABLE":               "dbo.VW_MB_POWERBI_SLS_REPORT",
    "ANALYTICS_RECOMPILE":                "1",
    "ANALYTICS_RECOMPILE_THRESHOLD":      "30",
    "SALES_ANALYTICS_AMOUNT_COLUMN":      "NetAmount",
    "SALES_ANALYTICS_BRANCH_DIM":         "BranchAlias",
    "SALES_ANALYTICS_DEPARTMENT_DIM":     "DepartmentShortName",
    "SALES_ANALYTICS_CATEGORY_DIM":       "CategoryShortName",
    "SALES_FILTER_DATE_COLUMN":           "XnDt",
    "SALES_ANALYTICS_INVOICE_COLUMN":     "",
    "SALES_VIEW":                         "dbo.VwAISalesData",
    "CUSTOMER_VIEW":                      "dbo.VwAICustomerDetails",
    "STOCK_VIEW":                         "dbo.VwAIStockData",
    "BRANCH_VIEW":                        "dbo.VwAIBranch",
    "SALESPERSON_TABLE":                  "dbo.MstSalesPerson",
    "SALESPERSON_TOPN_VIEW":              "dbo.VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID",
    "LANGGRAPH_LLM_SQL_CHECK":            "0",
}


async def _load_from_pg() -> dict[str, str]:
    try:
        from .db_postgres import pg_execute, pg_is_available
        if not await pg_is_available():
            return {}
        rows = await pg_execute(
            "SELECT key, value FROM erp_runtime_config",
            fetch=True,
        )
        return {r["key"]: r["value"] for r in (rows or [])}
    except Exception as e:
        print(f"[runtime-config] PG load failed (non-fatal): {e}")
        return {}


async def load() -> None:
    global _cache, _loaded
    pg_vals = await _load_from_pg()
    merged: dict[str, str] = {**_DEFAULTS}
    # Overlay env vars
    for k in _DEFAULTS:
        env_val = os.getenv(k)
        if env_val is not None:
            merged[k] = env_val
    # PG overrides env
    merged.update(pg_vals)
    _cache = merged
    _loaded = True
    print(f"[runtime-config] loaded {len(_cache)} keys ({len(pg_vals)} from PG)")


def get(key: str, default: Any = None) -> Any:
    if not _loaded:
        # Synchronous fallback — env then hardcoded defaults
        return os.getenv(key, _DEFAULTS.get(key, default))
    return _cache.get(key, os.getenv(key, _DEFAULTS.get(key, default)))


def get_int(key: str, default: int = 0) -> int:
    try:
        return int(get(key, default))
    except (TypeError, ValueError):
        return default


def get_bool(key: str, default: bool = False) -> bool:
    val = str(get(key, "1" if default else "0")).strip().lower()
    return val not in ("0", "false", "no", "off", "")


async def set_key(key: str, value: str) -> None:
    _cache[key] = value
    try:
        from .db_postgres import pg_execute
        await pg_execute(
            """INSERT INTO erp_runtime_config (key, value, updated_at)
               VALUES ($1, $2, NOW())
               ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()""",
            (key, value),
        )
    except Exception as e:
        print(f"[runtime-config] PG set failed (non-fatal): {e}")


async def set_many(updates: dict[str, str]) -> None:
    for k, v in updates.items():
        await set_key(k, v)


def all_settings() -> dict[str, str]:
    return dict(_cache)
