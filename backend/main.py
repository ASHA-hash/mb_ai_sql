"""
FastAPI application entry point.
Run with: uvicorn backend.main:app --reload --port 8000
"""
import os
import logging
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("erp-backend")

# ── Lifespan: startup / shutdown ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("ERP Python backend starting…")

    # 1. Ensure PostgreSQL tables exist
    try:
        from .services.db_postgres import ensure_tables
        await ensure_tables()
        logger.info("PostgreSQL tables verified")
        try:
            from .services.rbac import bootstrap_rbac_from_file
            await bootstrap_rbac_from_file()
        except Exception as boot_err:
            logger.warning(f"RBAC bootstrap skipped (non-fatal): {boot_err}")
    except Exception as e:
        logger.warning(f"PostgreSQL tables ensure failed (non-fatal): {e}")

    # 2. Load runtime config from PG
    try:
        from .services import runtime_config
        await runtime_config.load()
        logger.info("Runtime config loaded")
    except Exception as e:
        logger.warning(f"Runtime config load failed (non-fatal): {e}")

    # 3. Test ERP DB connection
    try:
        from .services.db_mssql import test_connection, set_connection_ok
        ok = await test_connection()
        set_connection_ok(ok)
        logger.info(f"ERP SQL Server: {'connected' if ok else 'UNREACHABLE'}")
    except Exception as e:
        logger.warning(f"ERP DB test failed (non-fatal): {e}")

    # 4. Pre-warm LangGraph graph (imports all services)
    try:
        from .services.langgraph_agent import get_graph
        get_graph()
        logger.info("LangGraph agent graph compiled")
    except Exception as e:
        logger.warning(f"LangGraph pre-warm failed (non-fatal): {e}")

    logger.info("ERP Python backend ready")
    yield

    logger.info("ERP Python backend shutting down")


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Smart ERP Integrations API",
    version="2.0.0",
    description="Python FastAPI backend — LangGraph AI + SQL Server + PostgreSQL RBAC",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ── CORS ──────────────────────────────────────────────────────────────────────
_CORS_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173,http://localhost:8000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
from .routers.auth_router   import router as auth_router
from .routers.query         import router as query_router
from .routers.analytics     import router as analytics_router
from .routers.datasets      import router as datasets_router
from .routers.sql_templates import router as sql_templates_router
from .routers.rag           import router as rag_router
from .routers.admin         import router as admin_router
from .routers.connector     import router as connector_router
from .routers.schema        import router as schema_router
from .routers.dataset_live  import router as dataset_live_router
from .services.auth         import get_current_user
from .routers.analytics     import kpi_for_period

app.include_router(auth_router)
app.include_router(query_router)
app.include_router(analytics_router)
app.include_router(datasets_router)
app.include_router(sql_templates_router)
app.include_router(rag_router)
app.include_router(admin_router)
app.include_router(connector_router)
app.include_router(schema_router)
app.include_router(dataset_live_router)


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "2.0.0", "backend": "python-fastapi"}


@app.get("/api/ping")
async def ping():
    return {"pong": True}


# Node-compatible lightweight KPI (same path as index.js GET /api/home/kpi)
@app.get("/api/home/kpi")
async def home_kpi(
    period: str = Query("today"),
    current_user: dict = Depends(get_current_user),
):
    return await kpi_for_period(period=period, current_user=current_user)


# ── Serve React frontend (production build) ───────────────────────────────────
_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


def _safe_dist_file(rel_path: str) -> Path | None:
    """Resolve a file under frontend/dist (blocks path traversal)."""
    if not rel_path or ".." in rel_path.replace("\\", "/"):
        return None
    root = _FRONTEND_DIST.resolve()
    target = (root / rel_path).resolve()
    if not str(target).startswith(str(root)):
        return None
    return target if target.is_file() else None


def _file_response(path: Path) -> FileResponse:
    media_type, _ = mimetypes.guess_type(str(path))
    return FileResponse(str(path), media_type=media_type or "application/octet-stream")


if _FRONTEND_DIST.exists():
    # Catch-all must serve /assets/* with correct MIME types. A bare mount("/assets")
    # loses to GET /{full_path:path} in Starlette, which returned index.html for .css → blank UI.

    @app.get("/", include_in_schema=False)
    async def spa_index():
        index = _FRONTEND_DIST / "index.html"
        if not index.exists():
            return JSONResponse(
                {"error": "Frontend not built. Run: cd frontend && npm run build"},
                status_code=503,
            )
        return FileResponse(str(index), media_type="text/html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        static = _safe_dist_file(full_path)
        if static:
            return _file_response(static)
        index = _FRONTEND_DIST / "index.html"
        if index.exists():
            return FileResponse(str(index), media_type="text/html")
        return JSONResponse(
            {"error": "Frontend not built. Run: cd frontend && npm run build"},
            status_code=503,
        )
else:
    @app.get("/", include_in_schema=False)
    async def root():
        return {
            "message": "ERP Python Backend is running.",
            "docs":    "/api/docs",
            "note":    "Frontend not built yet. Run: cd frontend && npm run build",
        }


# ── Global error handler ──────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception on {request.url}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc)},
    )
