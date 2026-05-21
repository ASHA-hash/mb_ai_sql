"""
RBAC — Role-Based Access Control.
PostgreSQL primary, users-config.json fallback.
"""
import os
import json
import hashlib
import hmac
from datetime import datetime
from typing import Optional
from passlib.context import CryptContext
from passlib.exc import UnknownHashError
from .db_postgres import pg_execute, pg_is_available

# Node.js auth.js uses: pbkdf2:<salt_hex>:<hash_hex> (sha256, 100k iters, 32-byte key)
_PBKDF2_ITERS = 100_000
_PBKDF2_DKLEN = 32

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "../../users-config.json")


def hash_password(plain: str) -> str:
    """Match Node auth.js format so hashes are interchangeable."""
    salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        plain.encode("utf-8"),
        salt.encode("utf-8"),
        _PBKDF2_ITERS,
        _PBKDF2_DKLEN,
    )
    return f"pbkdf2:{salt}:{dk.hex()}"


def _verify_pbkdf2_node(plain: str, stored: str) -> bool:
    parts = stored.split(":")
    if len(parts) != 3 or parts[0] != "pbkdf2":
        return False
    _, salt_str, expected_hex = parts
    try:
        expected = bytes.fromhex(expected_hex)
    except ValueError:
        return False
    if len(expected) != _PBKDF2_DKLEN:
        return False
    # Node.js crypto.pbkdf2Sync(password, salt, ...) — if salt is a string, UTF-8 is used (not binary from hex)
    dk = hashlib.pbkdf2_hmac(
        "sha256",
        plain.encode("utf-8"),
        salt_str.encode("utf-8"),
        _PBKDF2_ITERS,
        _PBKDF2_DKLEN,
    )
    return hmac.compare_digest(dk, expected)


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed or not isinstance(hashed, str):
        return False
    s = hashed.strip()
    if not s:
        return False
    # Primary: Node.js dashboard / rbac-pg.js format
    if s.startswith("pbkdf2:"):
        return _verify_pbkdf2_node(plain, s)
    # Legacy md5 (32 hex chars)
    if len(s) == 32 and not s.startswith("$"):
        return hashlib.md5(plain.encode()).hexdigest() == s
    # bcrypt (Python-created users or external)
    try:
        return _pwd_ctx.verify(plain, s)
    except UnknownHashError:
        return False


def _load_config_file() -> dict:
    try:
        with open(_CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {"roles": {}, "users": []}


async def get_user(email: str) -> Optional[dict]:
    """Fetch user from PostgreSQL, fall back to JSON file."""
    em = email.strip().lower()
    try:
        rows = await pg_execute(
            "SELECT email, role_key, name, password_hash FROM erp_rbac_users WHERE lower(email) = %s",
            (em,), fetch=True
        )
        if rows:
            r = rows[0]
            return {"email": r["email"], "role": r["role_key"],
                    "name": r["name"], "passwordHash": r["password_hash"]}
    except Exception:
        pass
    # JSON fallback
    cfg = _load_config_file()
    for u in cfg.get("users", []):
        if u.get("email", "").lower() == em:
            return u
    return None


async def get_role(role_key: str) -> Optional[dict]:
    try:
        rows = await pg_execute(
            "SELECT features_json, datasets_json FROM erp_rbac_roles WHERE role_key = %s",
            (role_key,), fetch=True
        )
        if rows:
            r = rows[0]
            return {
                "features": r["features_json"] if isinstance(r["features_json"], list) else [],
                "datasets": r["datasets_json"],
            }
    except Exception:
        pass
    cfg = _load_config_file()
    return cfg.get("roles", {}).get(role_key)


def _admin_default_password() -> str:
    return (os.getenv("ADMIN_DEFAULT_PASSWORD") or "Admin@1234").strip() or "Admin@1234"


def check_password_for_user(password: str, user: dict) -> bool:
    """Match Node auth.js checkUserPassword — hash in DB, else ADMIN_DEFAULT_PASSWORD when hash empty."""
    stored = str(user.get("passwordHash") or "").strip()
    if stored:
        return verify_password(password, stored)
    return password == _admin_default_password()


async def check_credentials(email: str, password: str) -> tuple[Optional[dict], Optional[str]]:
    """
    Returns (user, error_code).
    error_code: unknown_user | wrong_password
    """
    user = await get_user(email)
    if not user:
        return None, "unknown_user"
    if not check_password_for_user(password, user):
        return None, "wrong_password"
    return user, None


async def authenticate(email: str, password: str) -> Optional[dict]:
    user, _err = await check_credentials(email, password)
    return user


async def bootstrap_rbac_from_file() -> None:
    """First deploy: seed roles/users from users-config.json (Node rbac-pg.js parity)."""
    if not await pg_is_available():
        return
    try:
        meta = await pg_execute(
            "SELECT value FROM erp_rbac_meta WHERE key = 'users_bootstrapped'",
            fetch=True,
        )
        if meta:
            return
        cfg = _load_config_file()
        for role_key, defn in (cfg.get("roles") or {}).items():
            feats = defn.get("features", []) if isinstance(defn, dict) else []
            datasets = defn.get("datasets", "*") if isinstance(defn, dict) else "*"
            import json
            await pg_execute(
                """INSERT INTO erp_rbac_roles (role_key, features_json, datasets_json)
                   VALUES (%s, %s::jsonb, %s::jsonb)
                   ON CONFLICT (role_key) DO NOTHING""",
                (role_key, json.dumps(feats), json.dumps(datasets)),
            )
        for u in cfg.get("users") or []:
            email = str(u.get("email") or "").strip()
            role = str(u.get("role") or "").strip()
            if not email or not role:
                continue
            await pg_execute(
                """INSERT INTO erp_rbac_users (email, role_key, name, password_hash)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (email) DO NOTHING""",
                (
                    email.lower(),
                    role,
                    str(u.get("name") or "").strip(),
                    str(u.get("passwordHash") or "").strip(),
                ),
            )
        await pg_execute(
            """INSERT INTO erp_rbac_meta (key, value) VALUES ('users_bootstrapped', %s)
               ON CONFLICT (key) DO NOTHING""",
            (datetime.utcnow().isoformat(),),
        )
        print("[rbac] First-run bootstrap from users-config.json")
    except Exception as e:
        print(f"[rbac] bootstrap skipped: {e}")


async def list_users() -> list[dict]:
    try:
        rows = await pg_execute(
            "SELECT email, role_key, name FROM erp_rbac_users ORDER BY email",
            fetch=True
        )
        return [{"email": r["email"], "role": r["role_key"], "name": r["name"]} for r in rows]
    except Exception:
        cfg = _load_config_file()
        return [{"email": u.get("email"), "role": u.get("role"), "name": u.get("name", "")}
                for u in cfg.get("users", [])]


async def create_user(email: str, role: str, name: str, password: str) -> dict:
    pw_hash = hash_password(password)
    await pg_execute(
        """INSERT INTO erp_rbac_users (email, role_key, name, password_hash)
           VALUES (%s,%s,%s,%s) ON CONFLICT (email) DO UPDATE
           SET role_key = EXCLUDED.role_key, name = EXCLUDED.name, password_hash = EXCLUDED.password_hash""",
        (email.lower(), role, name, pw_hash)
    )
    return {"email": email, "role": role, "name": name}


async def update_user(email: str, updates: dict) -> bool:
    sets: list[str] = []
    params: list = []
    if "role" in updates:
        sets.append("role_key = %s")
        params.append(updates["role"])
    if "name" in updates:
        sets.append("name = %s")
        params.append(updates["name"])
    if "password" in updates:
        sets.append("password_hash = %s")
        params.append(hash_password(updates["password"]))
    if not sets:
        return False
    params.append(email.lower())
    await pg_execute(
        f"UPDATE erp_rbac_users SET {', '.join(sets)} WHERE lower(email) = %s",
        tuple(params),
    )
    return True


async def delete_user(email: str) -> bool:
    await pg_execute(
        "DELETE FROM erp_rbac_users WHERE lower(email) = %s",
        (email.lower(),)
    )
    return True
