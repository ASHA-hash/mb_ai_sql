"""
Auth router — login, token, user CRUD.
"""
from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, EmailStr
from typing import Optional

from ..services.auth import (
    create_token,
    get_current_user,
    require_admin,
    require_manager_or_admin,
)
from ..services.rbac import (
    check_credentials,
    list_users,
    create_user,
    update_user,
    delete_user,
    get_user,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Models ────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: str
    password: str


class CreateUserRequest(BaseModel):
    email: str
    role: str
    name: str = ""
    password: str


class UpdateUserRequest(BaseModel):
    role:     Optional[str] = None
    name:     Optional[str] = None
    password: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.post("/login")
async def login(body: LoginRequest):
    user, err = await check_credentials(body.email, body.password)
    if err == "unknown_user":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "This email is not registered. Use an account from users-config.json "
                "(e.g. ashakarthikeyan24@gmail.com) or ask an admin to add you."
            ),
        )
    if err == "wrong_password":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "Incorrect password. This deployment stores passwords in PostgreSQL — "
                "Admin@1234 is not valid unless that was set for your account. "
                "Use your real password, or ask an admin to reset it "
                "(python scripts/set_user_password.py your@email.com)."
            ),
        )
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_token(user["email"], user["role"])
    return {
        "token": token,
        "user":  {"email": user["email"], "role": user["role"], "name": user.get("name", "")},
    }


@router.get("/me")
async def me(current_user: dict = Depends(get_current_user)):
    return {
        "email":   current_user["email"],
        "role":    current_user["role"],
        "name":    current_user.get("name", ""),
        "roleDef": current_user.get("roleDef", {}),
    }


@router.get("/users")
async def get_users(current_user: dict = Depends(require_manager_or_admin)):
    return await list_users()


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user_endpoint(
    body: CreateUserRequest,
    current_user: dict = Depends(require_admin),
):
    return await create_user(body.email, body.role, body.name, body.password)


@router.patch("/users/{email}")
async def update_user_endpoint(
    email: str,
    body: UpdateUserRequest,
    current_user: dict = Depends(require_admin),
):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    ok = await update_user(email, updates)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found or no changes")
    return {"ok": True}


@router.delete("/users/{email}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_endpoint(
    email: str,
    current_user: dict = Depends(require_admin),
):
    await delete_user(email)
