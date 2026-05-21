"""
Datasets router — list available views, fetch data with filters and pagination.
"""
import json
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from ..services.auth import get_current_user
from ..services.db_mssql import execute_query, execute_scalar
from ..services import runtime_config as rc

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

_META = Path(__file__).parent.parent.parent / "metadata"


def _load_registry() -> dict:
    try:
        raw = json.loads((_META / "dataset-access.json").read_text())
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _load_schema() -> dict:
    try:
        raw = json.loads((_META / "db_tables_views_columns.json").read_text())
        return {**raw.get("views", {}), **raw.get("tables", {})}
    except Exception:
        return {}


@router.get("/")
async def list_datasets(current_user: dict = Depends(get_current_user)):
    """List all available datasets/views with column counts."""
    schema = _load_schema()
    datasets = []
    for view_name, view_obj in schema.items():
        if not isinstance(view_obj, dict):
            continue
        cols = view_obj.get("columns", {})
        datasets.append({
            "name":       view_name,
            "type":       view_obj.get("type", "view"),
            "columnCount": len(cols) if isinstance(cols, dict) else 0,
        })
    datasets.sort(key=lambda x: x["name"])
    return {"datasets": datasets, "count": len(datasets)}


@router.get("/{view_name}/schema")
async def get_schema(
    view_name: str,
    current_user: dict = Depends(get_current_user),
):
    schema = _load_schema()
    # URL-decode dots
    view_name = view_name.replace("__", ".")
    obj = schema.get(view_name)
    if not obj:
        # Try case-insensitive match
        for k in schema:
            if k.lower() == view_name.lower():
                obj = schema[k]
                view_name = k
                break
    if not obj:
        raise HTTPException(status_code=404, detail=f"View '{view_name}' not found")

    cols = obj.get("columns", {})
    col_list = [
        {"name": col_name, **({k: v for k, v in col_info.items()} if isinstance(col_info, dict) else {"data_type": "unknown"})}
        for col_name, col_info in (cols.items() if isinstance(cols, dict) else {})
    ]
    return {"view": view_name, "columns": col_list, "columnCount": len(col_list)}


class DataRequest(BaseModel):
    view:     str
    filters:  Optional[dict] = {}
    columns:  Optional[list[str]] = None
    limit:    Optional[int] = 1000
    offset:   Optional[int] = 0
    orderBy:  Optional[str] = None
    orderDir: Optional[str] = "DESC"


@router.post("/query")
async def query_dataset(
    body: DataRequest,
    current_user: dict = Depends(get_current_user),
):
    """Fetch rows from a view with optional filter/projection/pagination."""
    # Validate view name (prevent injection)
    if not body.view or not all(c.isalnum() or c in "._[] " for c in body.view):
        raise HTTPException(status_code=400, detail="Invalid view name")

    schema = _load_schema()
    view_key = body.view
    if view_key not in schema:
        for k in schema:
            if k.lower() == body.view.lower():
                view_key = k
                break

    hard_cap = rc.get_int("DATASET_HARD_CAP", 20000)
    page_max = rc.get_int("DATASET_PAGE_MAX", 1000)
    limit = min(body.limit or page_max, hard_cap)
    offset = body.offset or 0

    # Build SELECT list
    col_list = "*"
    if body.columns:
        safe_cols = [f"[{c}]" for c in body.columns if c.replace("_", "").replace(" ", "").isalnum()]
        if safe_cols:
            col_list = ", ".join(safe_cols)

    # Build WHERE clause from filters (string equality only — safe)
    where_parts = []
    params: list = []
    if body.filters:
        for col, val in body.filters.items():
            if col.replace("_", "").replace(" ", "").isalnum():
                where_parts.append(f"[{col}] = ?")
                params.append(val)

    where_clause = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""

    # ORDER BY
    order_clause = ""
    if body.orderBy and body.orderBy.replace("_", "").isalnum():
        direction = "ASC" if (body.orderDir or "DESC").upper() == "ASC" else "DESC"
        order_clause = f"ORDER BY [{body.orderBy}] {direction}"

    sql = f"""
    SELECT TOP {limit} {col_list}
    FROM {view_key} WITH (NOLOCK)
    {where_clause}
    {order_clause}
    """

    try:
        import asyncio
        timeout_s = rc.get_int("DB_REQUEST_TIMEOUT_MS", 120000) / 1000
        rows = await asyncio.wait_for(execute_query(sql, tuple(params)), timeout=timeout_s)

        # Serialize dates
        from datetime import datetime, date
        clean_rows = []
        for row in rows:
            clean_row = {}
            for k, v in row.items():
                if isinstance(v, (date, datetime)):
                    clean_row[k] = v.isoformat()
                else:
                    clean_row[k] = v
            clean_rows.append(clean_row)

        return {"data": clean_rows, "rowCount": len(clean_rows), "view": view_key}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="Query timed out — apply more filters")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{view_name}/count")
async def get_count(
    view_name: str,
    current_user: dict = Depends(get_current_user),
):
    """Return approximate row count for a view."""
    view_name = view_name.replace("__", ".")
    sql = f"SELECT COUNT(*) AS cnt FROM {view_name} WITH (NOLOCK)"
    try:
        count = await execute_scalar(sql)
        return {"view": view_name, "count": count}
    except Exception as e:
        return {"view": view_name, "count": None, "error": str(e)}
