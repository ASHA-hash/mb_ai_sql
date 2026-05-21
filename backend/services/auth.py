"""
JWT authentication — create/verify tokens, FastAPI dependency.
"""
import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from dotenv import load_dotenv

from .rbac import get_user, get_role

load_dotenv(os.path.join(os.path.dirname(__file__), "../../.env"))

_SECRET  = os.getenv("JWT_SECRET", "change-me")
_ALGO    = "HS256"
_EXPIRE  = 60 * 24 * 7  # 7 days in minutes

_bearer = HTTPBearer(auto_error=False)


def create_token(email: str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=_EXPIRE)
    payload = {"sub": email, "role": role, "exp": expire}
    return jwt.encode(payload, _SECRET, algorithm=_ALGO)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, _SECRET, algorithms=[_ALGO])
    except JWTError:
        return None


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict:
    """FastAPI dependency — injects user dict or raises 401."""
    if not creds:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(creds.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = await get_user(payload["sub"])
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    role_def = await get_role(user["role"])
    return {**user, "roleDef": role_def or {}}


def require_role(*roles: str):
    """Dependency factory — ensures user has one of the listed roles."""
    async def _check(user: dict = Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"Requires role: {', '.join(roles)}")
        return user
    return _check


def require_feature(feature: str):
    """Dependency factory — ensures user's role has the named feature enabled."""
    async def _check(user: dict = Depends(get_current_user)):
        role_def = user.get("roleDef", {})
        features = role_def.get("features", [])
        if features != "*" and feature not in features:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"Feature '{feature}' not enabled for your role")
        return user
    return _check


require_admin           = require_role("admin")
require_manager_or_admin = require_role("admin", "manager")
