"""
Schema explorer — parity with Node GET /api/schema/* (INFORMATION_SCHEMA).
"""
import re
from fastapi import APIRouter, Depends, Query, HTTPException

from ..services.auth import require_feature
from ..services.db_mssql import execute_query

router = APIRouter(tags=["schema"])

_ID = re.compile(r"^[a-zA-Z0-9_]+$")


def _sanitize_identifier(name: str) -> str | None:
    s = (name or "").strip()
    return s if s and _ID.match(s) else None


@router.get("/api/schema/objects")
async def schema_objects(user: dict = Depends(require_feature("explorer"))):
    del user
    sql = """
    SELECT
        TABLE_SCHEMA  AS [schema],
        TABLE_NAME    AS [name],
        TABLE_TYPE    AS [type]
    FROM INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_TYPE DESC, TABLE_SCHEMA, TABLE_NAME
    """
    try:
        rows = await execute_query(sql)
        tables = [r for r in rows if r.get("type") == "BASE TABLE"]
        views = [r for r in rows if r.get("type") == "VIEW"]
        return {"tables": tables, "views": views, "total": len(rows)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/api/schema/columns/{schema_name}/{object_name}")
async def schema_columns(
    schema_name: str,
    object_name: str,
    user: dict = Depends(require_feature("explorer")),
):
    del user
    sch = _sanitize_identifier(schema_name)
    obj = _sanitize_identifier(object_name)
    if not sch or not obj:
        raise HTTPException(status_code=400, detail="Invalid schema or object name")
    sql = """
    SELECT
        COLUMN_NAME        AS column_name,
        DATA_TYPE          AS data_type,
        IS_NULLABLE        AS is_nullable,
        CHARACTER_MAXIMUM_LENGTH AS max_length,
        NUMERIC_PRECISION  AS numeric_precision,
        NUMERIC_SCALE      AS numeric_scale,
        ORDINAL_POSITION   AS ordinal_position
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION
    """
    try:
        return await execute_query(sql, (sch, obj))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/api/schema/preview/{schema_name}/{object_name}")
async def schema_preview(
    schema_name: str,
    object_name: str,
    limit: int = Query(10, ge=1, le=50),
    user: dict = Depends(require_feature("explorer")),
):
    del user
    sch = _sanitize_identifier(schema_name)
    obj = _sanitize_identifier(object_name)
    if not sch or not obj:
        raise HTTPException(status_code=400, detail="Invalid schema or object name")
    sql = f"SELECT TOP {int(limit)} * FROM [{sch}].[{obj}]"
    try:
        rows = await execute_query(sql)
        from datetime import datetime, date
        out = []
        for row in rows:
            clean = {}
            for k, v in row.items():
                clean[k] = v.isoformat() if isinstance(v, (date, datetime)) else v
            out.append(clean)
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
