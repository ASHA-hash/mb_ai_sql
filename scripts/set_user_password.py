#!/usr/bin/env python3
"""
Reset a user's login password in PostgreSQL (erp_rbac_users).

Uses ADMIN_DEFAULT_PASSWORD from .env unless you pass a second argument.

  python scripts/set_user_password.py ashakarthikeyan24@gmail.com
  python scripts/set_user_password.py you@company.com "MyNewPass123"
"""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")


async def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python scripts/set_user_password.py <email> [new_password]")
        return 1

    email = sys.argv[1].strip().lower()
    new_pwd = (sys.argv[2] if len(sys.argv) > 2 else os.getenv("ADMIN_DEFAULT_PASSWORD") or "").strip()
    if not new_pwd:
        print("Set ADMIN_DEFAULT_PASSWORD in .env or pass password as second argument.")
        return 1

    from backend.services.rbac import get_user, update_user
    from backend.services.db_postgres import pg_is_available

    if not await pg_is_available():
        print("PostgreSQL (DATABASE_URL) is not available — cannot update password.")
        return 1

    user = await get_user(email)
    if not user:
        print(f"No user found for: {email}")
        print("Registered emails are in users-config.json in this repo.")
        return 1

    await update_user(email, {"password": new_pwd})
    print(f"Password updated for {email} ({user.get('role')}).")
    print("Sign in at /login with that email and the new password.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
