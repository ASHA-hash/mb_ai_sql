"""
SQL Templates router — CRUD for saved query templates.
"""
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

from ..services.auth import get_current_user, require_manager_or_admin
from ..services.db_postgres import pg_execute

router = APIRouter(prefix="/api/sql-templates", tags=["sql-templates"])


# ── Models ────────────────────────────────────────────────────────────────────
class TemplateCreate(BaseModel):
    name:        str
    sql:         str
    description: Optional[str] = ""


class TemplateUpdate(BaseModel):
    name:        Optional[str] = None
    sql:         Optional[str] = None
    description: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/")
async def list_templates(current_user: dict = Depends(get_current_user)):
    try:
        rows = await pg_execute(
            "SELECT id, name, sql, description, created_by, created_at, updated_at FROM erp_sql_templates ORDER BY updated_at DESC",
            fetch=True,
        )
        # Serialize dates
        templates = []
        for r in (rows or []):
            t = dict(r)
            for k in ("created_at", "updated_at"):
                if t.get(k) and hasattr(t[k], "isoformat"):
                    t[k] = t[k].isoformat()
            templates.append(t)
        return {"templates": templates}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    current_user: dict = Depends(get_current_user),
):
    if not body.name.strip() or not body.sql.strip():
        raise HTTPException(status_code=400, detail="name and sql are required")

    template_id = str(uuid.uuid4())
    try:
        await pg_execute(
            """INSERT INTO erp_sql_templates (id, name, sql, description, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, NOW(), NOW())""",
            (template_id, body.name.strip(), body.sql.strip(), body.description or "", current_user["email"]),
        )
        return {"id": template_id, "ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{template_id}")
async def update_template(
    template_id: str,
    body: TemplateUpdate,
    current_user: dict = Depends(get_current_user),
):
    parts, params = [], []
    if body.name is not None:
        parts.append(f"name=${len(params)+1}")
        params.append(body.name)
    if body.sql is not None:
        parts.append(f"sql=${len(params)+1}")
        params.append(body.sql)
    if body.description is not None:
        parts.append(f"description=${len(params)+1}")
        params.append(body.description)
    if not parts:
        raise HTTPException(status_code=400, detail="No fields to update")

    parts.append(f"updated_at=NOW()")
    params.append(template_id)

    try:
        await pg_execute(
            f"UPDATE erp_sql_templates SET {', '.join(parts)} WHERE id=${len(params)}",
            tuple(params),
        )
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    current_user: dict = Depends(get_current_user),
):
    try:
        await pg_execute(
            "DELETE FROM erp_sql_templates WHERE id=$1",
            (template_id,),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
