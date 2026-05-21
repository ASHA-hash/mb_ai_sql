"""
RAG (Retrieval-Augmented Generation) vector store.
Pure-Python cosine similarity over JSON-persisted embeddings.
Mirrors services/rag-store.js behaviour exactly.
"""
import os
import json
import time
import random
import string
import asyncio
from typing import Optional
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

STORE_PATH = Path(__file__).parent.parent.parent / "rag-store.json"

# ── In-memory document list ───────────────────────────────────────────────────
_docs: list[dict] = []
_loaded = False

# ── Embedder (lazy singleton) ─────────────────────────────────────────────────
_embedder = None


def _get_embedder():
    global _embedder
    if _embedder is None:
        from langchain_openai import OpenAIEmbeddings
        _embedder = OpenAIEmbeddings(
            model=os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
            openai_api_key=os.getenv("OPENAI_API_KEY"),
            dimensions=1536,
        )
    return _embedder


# ── Persistence ───────────────────────────────────────────────────────────────
def _load():
    global _docs, _loaded
    if _loaded:
        return
    try:
        if STORE_PATH.exists():
            raw = json.loads(STORE_PATH.read_text("utf-8"))
            _docs = raw if isinstance(raw, list) else []
            print(f"[rag-store] loaded {len(_docs)} docs")
    except Exception as e:
        print(f"[rag-store] load failed: {e}")
        _docs = []
    _loaded = True


def _save():
    try:
        STORE_PATH.write_text(json.dumps(_docs, indent=2), "utf-8")
    except Exception as e:
        print(f"[rag-store] save failed: {e}")


# ── Cosine similarity ─────────────────────────────────────────────────────────
def _cosine_sim(a: list[float], b: list[float]) -> float:
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na  += x * x
        nb  += y * y
    denom = (na ** 0.5) * (nb ** 0.5)
    return 0.0 if denom < 1e-10 else dot / denom


# ── ID generator ──────────────────────────────────────────────────────────────
def _gen_id() -> str:
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{int(time.time() * 1000)}-{suffix}"


# ── Internal add ─────────────────────────────────────────────────────────────
async def _add(text: str, metadata: dict) -> str:
    _load()
    loop = asyncio.get_event_loop()
    embedder = _get_embedder()
    embedding = await loop.run_in_executor(None, embedder.embed_query, str(text))
    doc_id = _gen_id()
    _docs.append({
        "id":        doc_id,
        "text":      text,
        "embedding": embedding,
        "metadata":  metadata,
        "addedAt":   time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    _save()
    return doc_id


# ── Public API ────────────────────────────────────────────────────────────────
async def add_example(question: str, sql: str, note: str = "") -> str:
    text = f"Q: {question}\nSQL: {sql}"
    if note:
        text += f"\nNote: {note}"
    return await _add(text, {"type": "example", "question": question, "sql": sql, "note": note})


async def add_glossary(term: str, definition: str) -> str:
    return await _add(f"{term}: {definition}", {"type": "glossary", "term": term, "definition": definition})


async def add_schema_chunk(view_name: str, col_text: str) -> str:
    return await _add(f"{view_name}\n{col_text}", {"type": "schema", "view": view_name})


async def search(query: str, k: int = 5, filter_meta: Optional[dict] = None) -> list[dict]:
    """Return top-k results by cosine similarity."""
    _load()
    if not _docs:
        return []
    try:
        loop = asyncio.get_event_loop()
        embedder = _get_embedder()
        q_vec = await loop.run_in_executor(None, embedder.embed_query, str(query))
    except Exception as e:
        print(f"[rag-store] embed failed: {e}")
        return []

    scored = []
    for doc in _docs:
        if filter_meta:
            meta = doc.get("metadata", {})
            if not all(meta.get(k_) == v for k_, v in filter_meta.items()):
                continue
        score = _cosine_sim(q_vec, doc.get("embedding", []))
        scored.append({
            "id":       doc["id"],
            "text":     doc["text"],
            "metadata": doc.get("metadata", {}),
            "score":    score,
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:k]


def remove(doc_id: str) -> bool:
    global _docs
    _load()
    before = len(_docs)
    _docs = [d for d in _docs if d["id"] != doc_id]
    if len(_docs) < before:
        _save()
        return True
    return False


def list_by_type(doc_type: str) -> list[dict]:
    _load()
    return [
        {"id": d["id"], "text": d["text"], "metadata": d.get("metadata", {}), "addedAt": d.get("addedAt")}
        for d in _docs
        if d.get("metadata", {}).get("type") == doc_type
    ]


def stats() -> dict:
    _load()
    by_type: dict[str, int] = {}
    for d in _docs:
        t = d.get("metadata", {}).get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
    return {"total": len(_docs), "byType": by_type}


# Ensure loaded on import
_load()
