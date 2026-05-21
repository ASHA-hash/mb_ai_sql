"""
SQL Server access via pyodbc + Microsoft ODBC driver.

Requires a SQL Server ODBC driver on the machine (same DB_* credentials as Node `mssql`).
Install: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server

IM002 "Data source name not found" usually means no driver name matched — set MSSQL_ODBC_DRIVER
to a name from `pyodbc.drivers()`, or install ODBC Driver 17/18 for SQL Server.
"""
import os
import asyncio
import queue
import time
from typing import Optional, Any
import pyodbc
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

_pool_size = max(1, int(os.getenv("DB_POOL_MAX", "10")))
_conn_pool: queue.Queue = queue.Queue(maxsize=_pool_size)

_last_ping_ok: Optional[bool] = None
_last_ping_ts: float = 0.0

_cached_conn_str: Optional[str] = None
_cached_error: Optional[str] = None


def _env_trim(key: str) -> str:
    v = os.getenv(key)
    return (v or "").strip()


def _encrypt_and_trust() -> tuple[str, str]:
    """Match Node getDbConfig(): DB_ENCRYPT gates encrypt; trustServerCertificate always true."""
    enc_env = _env_trim("DB_ENCRYPT").lower()
    use_encrypt = enc_env in ("1", "true", "yes")
    if use_encrypt:
        return "Encrypt=yes;", "TrustServerCertificate=yes;"
    return "Encrypt=no;", "TrustServerCertificate=yes;"


def _server_part() -> str:
    """
    SERVER clause for ODBC.
    - Named instance: host\\INSTANCE — do not append ,port (IM002 / wrong resolution).
    - Already has comma (host,port): use as-is.
    - Else: host,port
    """
    server = _env_trim("ERP_DB_HOST") or _env_trim("DB_SERVER")
    port = _env_trim("ERP_DB_PORT") or _env_trim("DB_PORT") or "1433"
    if not server:
        return ""
    if "," in server:
        return server
    if "\\" in server:
        return server
    return f"{server},{port}"


def _pick_odbc_driver() -> str:
    explicit = (
        _env_trim("MSSQL_ODBC_DRIVER")
        or _env_trim("ERP_ODBC_DRIVER")
        or _env_trim("DB_ODBC_DRIVER")
    )
    if explicit:
        return explicit

    available = set(pyodbc.drivers())
    preferred = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "ODBC Driver 13 for SQL Server",
        "ODBC Driver 11 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server Native Client 10.0",
        "SQL Server",
    ]
    for name in preferred:
        if name in available:
            return name

    for d in sorted(available):
        if "SQL Server" in d or "Native Client" in d:
            return d

    raise RuntimeError(
        "No SQL Server ODBC driver is installed (or none detected). "
        "Install 'Microsoft ODBC Driver 18 for SQL Server' for Windows, "
        "or set env MSSQL_ODBC_DRIVER to one of: "
        f"{sorted(available) or ['(none — list empty)']}"
    )


def build_conn_string() -> str:
    global _cached_conn_str, _cached_error
    if _cached_conn_str is not None:
        return _cached_conn_str
    if _cached_error is not None:
        raise RuntimeError(_cached_error)

    database = _env_trim("ERP_DB_NAME") or _env_trim("DB_NAME")
    user = _env_trim("ERP_DB_USER") or _env_trim("DB_USER")
    password = _env_trim("ERP_DB_PASSWORD") or _env_trim("DB_PASSWORD")
    server = _server_part()
    timeout = max(1, int(_env_trim("DB_CONNECT_TIMEOUT_MS") or "60000") // 1000)

    if not server or not database or not user:
        _cached_error = (
            "SQL Server env incomplete: set DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD "
            "(same as Node). Optional: DB_PORT, DB_ENCRYPT, MSSQL_ODBC_DRIVER."
        )
        raise RuntimeError(_cached_error)

    try:
        driver = _pick_odbc_driver()
    except RuntimeError as e:
        _cached_error = str(e)
        raise

    enc, trust = _encrypt_and_trust()

    _cached_conn_str = (
        f"DRIVER={{{driver}}};"
        f"SERVER={server};"
        f"DATABASE={database};"
        f"UID={user};"
        f"PWD={password};"
        f"{enc}"
        f"{trust}"
        f"Connection Timeout={timeout};"
    )
    return _cached_conn_str


def get_connection() -> pyodbc.Connection:
    conn_str = build_conn_string()
    connect_s = max(1, int(_env_trim("DB_CONNECT_TIMEOUT_MS") or "60000") // 1000)
    conn = pyodbc.connect(conn_str, timeout=connect_s)
    conn.timeout = max(1, int(_env_trim("DB_REQUEST_TIMEOUT_MS") or "120000") // 1000)
    return conn


def _pool_acquire() -> pyodbc.Connection:
    try:
        return _conn_pool.get_nowait()
    except queue.Empty:
        return get_connection()


def _pool_release(conn: pyodbc.Connection, *, broken: bool = False) -> None:
    if broken:
        try:
            conn.close()
        except Exception:
            pass
        return
    try:
        _conn_pool.put_nowait(conn)
    except queue.Full:
        try:
            conn.close()
        except Exception:
            pass


def _sql_batch(sql: str) -> str:
    """
    ODBC drivers may send SET options without a trailing semicolon; the next statement
    can then be misparsed (e.g. WITH (NOLOCK) mistaken for a CTE → error 319).
    Leading ';' makes the batch unambiguous.
    """
    s = (sql or "").strip()
    if not s:
        return s
    if not s.startswith(";"):
        s = ";" + s
    return s


async def execute_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    loop = asyncio.get_event_loop()
    sql = _sql_batch(sql)

    def _run():
        conn = _pool_acquire()
        broken = False
        try:
            cursor = conn.cursor()
            cursor.execute(sql, params)
            columns = [col[0] for col in cursor.description]
            rows = cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]
        except Exception:
            broken = True
            raise
        finally:
            _pool_release(conn, broken=broken)

    return await loop.run_in_executor(None, _run)


async def execute_scalar(sql: str, params: tuple = ()) -> Any:
    rows = await execute_query(sql, params)
    if not rows:
        return None
    return next(iter(rows[0].values()), None)


async def test_connection() -> bool:
    try:
        await execute_scalar("SELECT 1 AS ok")
        global _last_ping_ok, _last_ping_ts
        _last_ping_ok, _last_ping_ts = True, time.time()
        return True
    except Exception:
        _last_ping_ok, _last_ping_ts = False, time.time()
        return False


def set_connection_ok(ok: bool) -> None:
    """Called at startup so /api/admin/status skips a cold ODBC handshake."""
    global _last_ping_ok, _last_ping_ts
    _last_ping_ok, _last_ping_ts = ok, time.time()


async def test_connection_cached(ttl_sec: int = 90) -> bool:
    global _last_ping_ok, _last_ping_ts
    if _last_ping_ok is not None and (time.time() - _last_ping_ts) < ttl_sec:
        return _last_ping_ok
    return await test_connection()
