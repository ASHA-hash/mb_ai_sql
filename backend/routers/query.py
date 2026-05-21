"""
AI Query router — adaptive NL→SQL endpoint backed by the Python LangGraph agent.
"""
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..services.auth import get_current_user
from ..services.langgraph_agent import run_query

router = APIRouter(prefix="/api/query", tags=["query"])


# ── Models ────────────────────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    question:            str
    aiProvider:          Optional[str] = "openai"
    conversationHistory: Optional[list[dict]] = []
    userDateRange:       Optional[dict] = None
    tableHint:           Optional[str] = ""
    dateContext:         Optional[str] = ""
    adaptiveEnrichment:  Optional[str] = ""


class FeedbackRequest(BaseModel):
    question:   str
    sql:        str
    corrected:  Optional[str] = None
    helpful:    Optional[bool] = True
    note:       Optional[str] = ""


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.post("/adaptive")
async def adaptive_query(
    body: QueryRequest,
    current_user: dict = Depends(get_current_user),
):
    """Main NL→SQL endpoint. Runs the full LangGraph pipeline."""
    if not body.question or not body.question.strip():
        raise HTTPException(status_code=400, detail="Question is required")

    q = body.question.strip()[:1000]
    provider = (body.aiProvider or "openai").lower()
    if provider not in ("openai", "anthropic"):
        provider = "openai"

    # Sanitise conversation history
    history = [
        {
            "question": str(h.get("question", ""))[:500],
            "sql":      str(h.get("sql", ""))[:2000],
            "summary":  str(h.get("summary", ""))[:300],
        }
        for h in (body.conversationHistory or [])[-3:]
    ]

    t0 = time.perf_counter()
    result = await run_query(
        question=q,
        ai_provider=provider,
        conversation_history=history,
        user_date_range=body.userDateRange,
        table_hint=body.tableHint or "",
        date_context=body.dateContext or "",
        adaptive_enrichment=body.adaptiveEnrichment or "",
    )
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    # Log to ai_history
    try:
        from ..services.db_postgres import pg_execute
        await pg_execute(
            "INSERT INTO erp_ai_history (email, query, ts) VALUES ($1, $2, NOW())",
            (current_user["email"], q),
        )
    except Exception:
        pass

    return {
        "answer":       result.get("answer", ""),
        "sql":          result.get("sql", ""),
        "data":         result.get("data", []),
        "rowCount":     result.get("row_count", 0),
        "confidence":   result.get("confidence", "medium"),
        "confidenceNote": result.get("confidence_note", ""),
        "nodeLog":      result.get("node_log", []),
        "intent":       result.get("intent"),
        "retryCount":   result.get("retry_count", 0),
        "elapsedMs":    elapsed_ms,
        "provider":     provider,
        "mode":         result.get("mode", "langgraph"),
    }


@router.post("/langchain")
async def langchain_query(
    body: QueryRequest,
    current_user: dict = Depends(get_current_user),
):
    """Alias for /adaptive — explicit LangGraph route for backward compat."""
    return await adaptive_query(body, current_user)


@router.post("/feedback")
async def submit_feedback(
    body: FeedbackRequest,
    current_user: dict = Depends(get_current_user),
):
    """Save user feedback / SQL correction into RAG store."""
    if not body.question or not body.sql:
        raise HTTPException(status_code=400, detail="question and sql are required")

    from ..services import rag_store

    if body.corrected:
        # Add corrected SQL as a high-quality RAG example
        doc_id = await rag_store.add_example(
            question=body.question,
            sql=body.corrected,
            note=f"user-corrected by {current_user['email']}",
        )
        return {"ok": True, "action": "corrected", "id": doc_id}

    if body.helpful:
        doc_id = await rag_store.add_example(
            question=body.question,
            sql=body.sql,
            note=f"confirmed-helpful by {current_user['email']}",
        )
        return {"ok": True, "action": "approved", "id": doc_id}

    return {"ok": True, "action": "noted"}


@router.get("/history")
async def query_history(
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    """Return recent AI query history for the current user."""
    try:
        from ..services.db_postgres import pg_execute
        rows = await pg_execute(
            "SELECT query, ts FROM erp_ai_history WHERE email=$1 ORDER BY ts DESC LIMIT $2",
            (current_user["email"], min(limit, 200)),
            fetch=True,
        )
        return {"history": rows or []}
    except Exception as e:
        return {"history": [], "error": str(e)}


@router.delete("/history")
async def clear_history(current_user: dict = Depends(get_current_user)):
    """Clear AI query history for the current user."""
    try:
        from ..services.db_postgres import pg_execute
        await pg_execute(
            "DELETE FROM erp_ai_history WHERE email=$1",
            (current_user["email"],),
        )
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/suggestions")
async def get_suggestions(current_user: dict = Depends(get_current_user)):
    """Return dynamic AI-learned query suggestions from RAG store."""
    try:
        from ..services import rag_store
        examples = rag_store.list_by_type("example")
        chips = []
        seen = set()
        for ex in examples[-20:]:
            q = ex.get("metadata", {}).get("question", "")
            if q and q not in seen and len(q) < 80:
                seen.add(q)
                chips.append({"text": q, "source": "rag"})

        if not chips:
            chips = [
                {"text": "Today's total sales", "source": "default"},
                {"text": "MTD sales by branch", "source": "default"},
                {"text": "Top 10 selling articles this month", "source": "default"},
                {"text": "Stock value by department", "source": "default"},
                {"text": "New customers this week", "source": "default"},
            ]

        return {"suggestions": chips[:10], "fromRag": bool(chips and chips[0].get("source") == "rag")}
    except Exception as e:
        return {
            "suggestions": [
                {"text": "Today's total sales", "source": "default"},
                {"text": "MTD sales by branch", "source": "default"},
            ],
            "error": str(e),
        }
