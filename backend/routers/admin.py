"""
Admin router — runtime config, system status, RBAC role management.
"""
import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..services.auth import require_admin, get_current_user
from ..services import runtime_config as rc
from ..services.db_postgres import pg_is_available
from ..services.db_mssql import test_connection_cached

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ── Models ────────────────────────────────────────────────────────────────────
class ConfigUpdate(BaseModel):
    key:   str
    value: str


class BulkConfigUpdate(BaseModel):
    settings: dict[str, str]


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/settings")
async def get_settings(current_user: dict = Depends(require_admin)):
    """Return all runtime configuration settings."""
    return {"settings": rc.all_settings()}


@router.post("/settings")
async def update_setting(
    body: ConfigUpdate,
    current_user: dict = Depends(require_admin),
):
    if not body.key.strip():
        raise HTTPException(status_code=400, detail="key is required")
    await rc.set_key(body.key.strip(), body.value)
    return {"ok": True, "key": body.key, "value": body.value}


@router.post("/settings/bulk")
async def bulk_update_settings(
    body: BulkConfigUpdate,
    current_user: dict = Depends(require_admin),
):
    await rc.set_many(body.settings)
    return {"ok": True, "updated": list(body.settings.keys())}


@router.get("/status")
async def system_status(current_user: dict = Depends(get_current_user)):
    """Health check for all connected services."""
    import asyncio
    pg_ok, mssql_ok = await asyncio.gather(
        pg_is_available(),
        test_connection_cached(90),
    )

    from ..services import rag_store
    rag_stats = rag_store.stats()

    return {
        "postgres": pg_ok,
        "mssql":    mssql_ok,
        "rag":      rag_stats,
        "config": {
            "openai_model":    rc.get("OPENAI_MODEL"),
            "anthropic_model": rc.get("ANTHROPIC_MODEL"),
            "sales_table":     rc.get("SALES_AI_TABLE"),
        },
        "env": {
            "openai_key_set":    bool(os.getenv("OPENAI_API_KEY")),
            "anthropic_key_set": bool(os.getenv("ANTHROPIC_API_KEY")),
            "pg_url_set":        bool(os.getenv("RBAC_DATABASE_URL") or os.getenv("DATABASE_URL")),
            "erp_db_set":        bool(os.getenv("ERP_DB_HOST") or os.getenv("DB_SERVER")),
        },
    }


@router.get("/roles")
async def list_roles(current_user: dict = Depends(require_admin)):
    """List all RBAC roles from PostgreSQL."""
    try:
        from ..services.db_postgres import pg_execute
        rows = await pg_execute(
            "SELECT role_key, features_json, datasets_json FROM erp_rbac_roles ORDER BY role_key",
            fetch=True,
        )
        return {"roles": rows or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RoleUpsert(BaseModel):
    role_key:  str
    features:  list[str] | str = []
    datasets:  list[str] | str = "*"


@router.post("/roles")
async def upsert_role(
    body: RoleUpsert,
    current_user: dict = Depends(require_admin),
):
    import json
    features_json = json.dumps(body.features)
    datasets_json = json.dumps(body.datasets)
    try:
        from ..services.db_postgres import pg_execute
        await pg_execute(
            """INSERT INTO erp_rbac_roles (role_key, features_json, datasets_json)
               VALUES ($1, $2::jsonb, $3::jsonb)
               ON CONFLICT (role_key) DO UPDATE
               SET features_json=$2::jsonb, datasets_json=$3::jsonb""",
            (body.role_key, features_json, datasets_json),
        )
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/roles/{role_key}", status_code=204)
async def delete_role(
    role_key: str,
    current_user: dict = Depends(require_admin),
):
    try:
        from ..services.db_postgres import pg_execute
        await pg_execute("DELETE FROM erp_rbac_roles WHERE role_key=$1", (role_key,))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
