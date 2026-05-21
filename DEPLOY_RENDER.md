# Deploy Python + React on Render (mb_ai_sql)

Use your **existing** Render setup — no second app server.

| Render resource | Role |
|-----------------|------|
| **mb_ai_sql** (Web Service) | FastAPI + built React UI → `smarterpconnector.in` |
| **erp_connector** (PostgreSQL) | Login, RBAC, settings — link to `mb_ai_sql` |

---

## 1. Push code

Repo: `ASHA-hash/mb_ai_sql` (must include `backend/`, `frontend/`, `Dockerfile`).

```bash
git add backend frontend Dockerfile DEPLOY_RENDER.md
git commit -m "Deploy: Python FastAPI + React SPA on Render"
git push origin main
```

---

## 2. Change `mb_ai_sql` from Node → Docker

**Dashboard → mb_ai_sql → Settings**

| Field | Old (Node) | New (Python + React) |
|--------|------------|----------------------|
| **Runtime** | Node | **Docker** |
| **Root Directory** | *(empty)* | *(empty)* |
| **Build Command** | `npm install` | *(leave empty — Docker builds)* |
| **Start Command** | `node index.js` | *(leave empty — uses Dockerfile CMD)* |
| **Health Check Path** | *(empty)* | `/api/health` |

Save → **Manual Deploy**.

---

## 3. Link Postgres

**mb_ai_sql → Environment → Link Database** → select **erp_connector**.

Render injects **`DATABASE_URL`**. Do not paste a second Postgres URL unless you use `RBAC_DATABASE_URL` override.

---

## 4. Environment variables

Copy from your local `.env` into **mb_ai_sql → Environment** (never commit `.env`).

**Required**

| Variable | Example / notes |
|----------|------------------|
| `DB_SERVER` or `ERP_DB_HOST` | SQL Server host |
| `DB_PORT` | `1433` |
| `DB_USER` | ERP SQL login |
| `DB_PASSWORD` | ERP SQL password |
| `DB_NAME` | e.g. `zRetailHQ0` |
| `MSSQL_ODBC_DRIVER` | `ODBC Driver 18 for SQL Server` |
| `JWT_SECRET` | Long random string |
| `ADMIN_DEFAULT_PASSWORD` | First admin login |
| `OPENAI_API_KEY` | For AI Query |
| `ANTHROPICS_API_KEY` or `ANTHROPIC_API_KEY` | If using Claude |
| `ANALYTICS_BASE_TABLE` | `dbo.VW_MB_POWERBI_SLS_REPORT` |

**Recommended**

| Variable | Value |
|----------|--------|
| `CORS_ORIGINS` | `https://smarterpconnector.in,https://www.smarterpconnector.in,https://mb-ai-sql-v8wk.onrender.com` |
| `RBAC_ENABLED` | `1` |
| `API_KEY` | Same as Apps Script `ERP_API_KEY` (if used) |

`DATABASE_URL` comes from linking **erp_connector**.

---

## 5. SQL Server firewall

Render runs in the cloud. Your SQL Server must accept connections from Render (Azure: firewall rules / allow public + restrict by IP if possible).

Test after deploy: **Admin** or `GET /api/health` and login.

---

## 6. Verify

1. `https://smarterpconnector.in/api/health` → `{"status":"ok","backend":"python-fastapi",...}`
2. `https://smarterpconnector.in/` → React login (not old `dashboard.html`)
3. Login → **AI Query** → e.g. `Sales this month vs same month last year` (chart + ~60–90s)

---

## 7. Free tier limits

Current plan: **512 MB RAM**, **Free** instance.

- Cold starts after idle (~1 min first load).
- Heavy AI/analytics queries (60–180s) may **timeout** on Free; upgrade to **Starter** ($7/mo) for more RAM and longer requests if needed.

---

## Architecture (one server)

```
smarterpconnector.in  →  mb_ai_sql (Docker)
                              ├─ /          React (frontend/dist)
                              ├─ /api/*     FastAPI
                              ├─ DATABASE_URL → erp_connector (Postgres)
                              └─ DB_*       → your SQL Server (ERP)
```

No second web service. Old `node index.js` + static HTML panels are replaced by this stack unless you keep a separate legacy deploy.
