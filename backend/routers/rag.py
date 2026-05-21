"""
RAG router — manage the RAG vector store (examples, glossary, stats).
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

from ..services.auth import get_current_user, require_manager_or_admin
from ..services import rag_store

router = APIRouter(prefix="/api/rag", tags=["rag"])


# ── Models ────────────────────────────────────────────────────────────────────
class ExampleAdd(BaseModel):
    question: str
    sql:      str
    note:     Optional[str] = ""


class GlossaryAdd(BaseModel):
    term:       str
    definition: str


class SearchRequest(BaseModel):
    query: str
    k:     Optional[int] = 5
    type:  Optional[str] = None  # "example" | "glossary" | "schema"


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/stats")
async def stats(current_user: dict = Depends(get_current_user)):
    return rag_store.stats()


@router.get("/examples")
async def list_examples(current_user: dict = Depends(get_current_user)):
    return {"examples": rag_store.list_by_type("example")}


@router.get("/glossary")
async def list_glossary(current_user: dict = Depends(get_current_user)):
    return {"glossary": rag_store.list_by_type("glossary")}


@router.post("/examples", status_code=status.HTTP_201_CREATED)
async def add_example(
    body: ExampleAdd,
    current_user: dict = Depends(require_manager_or_admin),
):
    if not body.question.strip() or not body.sql.strip():
        raise HTTPException(status_code=400, detail="question and sql are required")
    doc_id = await rag_store.add_example(body.question, body.sql, body.note or "")
    return {"id": doc_id, "ok": True}


@router.post("/glossary", status_code=status.HTTP_201_CREATED)
async def add_glossary(
    body: GlossaryAdd,
    current_user: dict = Depends(require_manager_or_admin),
):
    if not body.term.strip() or not body.definition.strip():
        raise HTTPException(status_code=400, detail="term and definition are required")
    doc_id = await rag_store.add_glossary(body.term, body.definition)
    return {"id": doc_id, "ok": True}


@router.post("/search")
async def search_rag(
    body: SearchRequest,
    current_user: dict = Depends(get_current_user),
):
    filter_meta = {"type": body.type} if body.type else None
    results = await rag_store.search(body.query, k=min(body.k or 5, 20), filter_meta=filter_meta)
    return {
        "results": [
            {"id": r["id"], "text": r["text"], "score": round(r["score"], 4), "metadata": r["metadata"]}
            for r in results
        ]
    }


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    doc_id: str,
    current_user: dict = Depends(require_manager_or_admin),
):
    ok = rag_store.remove(doc_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Document not found")
