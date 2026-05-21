"""
GET /api/dataset/:key — load registry datasets (simplified parity with Node).
"""
import asyncio
from datetime import datetime, date

from fastapi import APIRouter, Depends, Query, HTTPException, Response

from ..services.auth import require_feature
from ..services.db_mssql import execute_query
from ..services import runtime_config as rc
from ..services.dataset_registry import normalize_key, resolve_table

router = APIRouter(tags=["dataset"])


def _parse_limit(raw: str | None) -> int:
    hard_cap = rc.get_int("DATASET_HARD_CAP", 20000)
    page_max = rc.get_int("DATASET_PAGE_MAX", 1000)
    if not raw or str(raw).lower() == "all":
        return hard_cap
    try:
        n = int(raw)
    except ValueError:
        n = 500
    return max(1, min(n, hard_cap, page_max))


def _serialize_rows(rows: list) -> list:
    out = []
    for row in rows:
        clean = {}
        for k, v in row.items():
            clean[k] = v.isoformat() if isinstance(v, (date, datetime)) else v
        out.append(clean)
    return out


@router.get("/api/dataset/{name}")
async def get_dataset(
    name: str,
    response: Response,
    limit: str = Query("500"),
    user: dict = Depends(require_feature("data")),
):
    del user
    dk = normalize_key(name)
    try:
        table, _entry = resolve_table(name)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if not table:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "unknown_dataset",
                "message": f"Unknown dataset key: {dk}",
                "hint": "GET /api/connector-config lists valid keys (e.g. sales, mb_powerbi_app_report)",
            },
        )

    row_limit = _parse_limit(limit)
    hard_cap = rc.get_int("DATASET_HARD_CAP", 20000)
    sql = f"SELECT TOP {row_limit} * FROM {table} WITH (NOLOCK)"

    try:
        timeout_s = rc.get_int("DB_REQUEST_TIMEOUT_MS", 120000) / 1000
        rows = await asyncio.wait_for(execute_query(sql), timeout=timeout_s)
        data = _serialize_rows(rows)
        response.headers["X-ERP-Data-Source"] = "live"
        response.headers["X-ERP-Row-Limit"] = str(row_limit)
        response.headers["X-ERP-Hard-Cap"] = str(hard_cap)
        response.headers["X-ERP-Row-Count"] = str(len(data))
        response.headers["X-ERP-Rows-Capped"] = "1" if len(data) >= row_limit else "0"
        return data
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="Query timed out — use a smaller row limit") from None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
