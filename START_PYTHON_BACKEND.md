# Starting the Python FastAPI Backend + React Frontend

## Quick Start

### 1. Backend (Python FastAPI)

```bash
# From the project root directory
cd "SMART ERP INTEGRATIONS FROM GOOGLE SHEETS"

# Install dependencies (first time only)
pip install -r backend/requirements.txt

# Start the backend
uvicorn backend.main:app --reload --port 8000
```

The backend starts at **http://localhost:8000**
- API docs: http://localhost:8000/api/docs
- Health check: http://localhost:8000/api/health

### 2. Frontend (Vite + React)

```bash
# In a second terminal, from the frontend directory
cd frontend

# Install packages (first time only)
npm install

# Start dev server
npm run dev
```

The frontend starts at **http://localhost:5173**
During development, all `/api/*` calls are proxied to the backend at port 8000.

### 3. Production Build

```bash
cd frontend
npm run build
# Built files go to frontend/dist/
# FastAPI automatically serves them from the same port 8000
```

---

## Environment Variables (.env)

The backend reads from the `.env` file in the project root. Required variables:

```
# AI Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# ERP SQL Server
ERP_DB_HOST=your-sql-server.database.windows.net
ERP_DB_NAME=zRetailHQ0
ERP_DB_USER=your_user
ERP_DB_PASSWORD=your_password
ERP_DB_PORT=1433

# PostgreSQL (RBAC + config storage)
RBAC_DATABASE_URL=postgresql://user:pass@host:5432/dbname

# JWT
JWT_SECRET=your-secret-key-change-this
```

---

## Architecture

```
frontend/          ← Vite + React + TypeScript
  src/
    lib/api.ts     ← Typed API client (all fetch calls)
    lib/auth.tsx   ← Auth context (JWT token management)
    pages/         ← Dashboard, AIQuery, Analytics, Admin, RAGPanel
    components/    ← Layout (sidebar navigation)

backend/           ← Python FastAPI
  main.py          ← FastAPI app, CORS, startup, router mounting
  services/
    langgraph_agent.py  ← LangGraph 8-node AI pipeline (Python)
    rag_store.py        ← RAG vector store with JSON persistence
    runtime_config.py   ← Hot-reloadable config (PG + .env fallback)
    auth.py             ← JWT creation/verification, FastAPI deps
    rbac.py             ← User management (PG + JSON fallback)
    db_postgres.py      ← PostgreSQL for RBAC/config/templates
    db_mssql.py         ← SQL Server for ERP data
  routers/
    auth_router.py      ← /api/auth/* (login, users)
    query.py            ← /api/query/* (NL→SQL, feedback, history)
    analytics.py        ← /api/analytics/* (KPIs, period, trend, YoY)
    datasets.py         ← /api/datasets/* (schema, data query)
    sql_templates.py    ← /api/sql-templates/* (CRUD)
    rag.py              ← /api/rag/* (examples, glossary, search)
    admin.py            ← /api/admin/* (settings, status, roles)
```

---

## API Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Login, get JWT token |
| GET | /api/auth/me | Current user info |
| POST | /api/query/adaptive | NL→SQL via LangGraph |
| POST | /api/query/feedback | Save SQL feedback to RAG |
| GET | /api/query/suggestions | Dynamic AI-learned suggestions |
| GET | /api/analytics/home-kpis | Today + MTD sales |
| GET | /api/analytics/period | Period breakdown by dimension |
| GET | /api/analytics/trend | Daily sales trend |
| GET | /api/analytics/yoy | Year-on-year comparison |
| GET | /api/datasets/ | List all views/tables |
| POST | /api/datasets/query | Query a dataset |
| GET | /api/sql-templates/ | List saved SQL templates |
| POST | /api/sql-templates/ | Create template |
| GET | /api/rag/stats | RAG store statistics |
| POST | /api/rag/examples | Add Q→SQL example |
| POST | /api/rag/search | Semantic search |
| GET | /api/admin/status | System health check |
| GET | /api/admin/settings | Runtime config |
| POST | /api/admin/settings | Update a setting |
| GET | /api/health | Health check |

---

## LangGraph Pipeline

The Python LangGraph agent (`backend/services/langgraph_agent.py`) runs these nodes:

```
pre_flight_gate
    → retrieve_context (RAG: similar Q→SQL pairs)
    → resolve_intent (NL→structured JSON plan)
    → discover_column_values (live DB value sampling)
    → generate_sql (LLM: GPT-4o / Claude)
    → check_sql (validation + optional LLM review)
    → execute_sql (run against SQL Server)
    → [error_recovery × 3] (self-healing retry)
    → generate_answer (LLM: natural language summary)
```

Key accuracy features:
- Schema loaded from `metadata/db_tables_views_columns.json` (exact column names)
- Semantic mapping injection (`metadata/semantic-mapping-layer.json`)
- Live value sampling before SQL generation (prevents hallucinated WHERE values)
- Column compliance guard (blocks/repairs illegal column names)
- Multi-turn conversation context (last 3 Q→SQL pairs)
- RAG memory (similar past queries injected as few-shot examples)
