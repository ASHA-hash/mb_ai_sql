"""
PostgreSQL connection for RBAC users, runtime config, and SQL templates.
"""
import os
import asyncio
from typing import Any, Optional
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

_conn: Optional[psycopg2.extensions.connection] = None


def _get_url() -> str:
    return os.getenv("RBAC_DATABASE_URL") or os.getenv("DATABASE_URL") or ""


def _ssl_args(url: str) -> dict:
    if "localhost" in url or "127.0.0.1" in url:
        return {}
    return {"sslmode": "require"}


def get_pg_connection() -> psycopg2.extensions.connection:
    global _conn
    url = _get_url()
    if not url:
        raise RuntimeError("No DATABASE_URL / RBAC_DATABASE_URL set")
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(url, **_ssl_args(url))
        _conn.autocommit = True
    return _conn


async def pg_execute(sql: str, params: tuple = (), fetch: bool = False) -> Any:
    loop = asyncio.get_event_loop()

    def _run():
        conn = get_pg_connection()
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            if fetch:
                return [dict(r) for r in cur.fetchall()]
            return None

    return await loop.run_in_executor(None, _run)


async def ensure_tables() -> None:
    """Create all application tables if they don't exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS erp_rbac_roles (
        role_key TEXT PRIMARY KEY,
        features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        datasets_json JSONB NOT NULL DEFAULT '"*"'::jsonb
    );
    CREATE TABLE IF NOT EXISTS erp_rbac_users (
        email TEXT PRIMARY KEY,
        role_key TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS erp_rbac_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS erp_runtime_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS erp_sql_templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sql         TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS erp_ai_history (
        email      TEXT NOT NULL,
        query      TEXT NOT NULL,
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """
    await pg_execute(ddl)


async def pg_is_available() -> bool:
    try:
        await pg_execute("SELECT 1")
        return True
    except Exception:
        return False
