"""Create a local (AUTH_MODE=local) user from the command line.

Usage (inside the backend container):
    python scripts/create_user.py user@example.com 'password123'
    python scripts/create_user.py admin@example.com 'password123' --admin --name "Boss"

The first admin is normally bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD on
startup; this script is for managing additional accounts without the UI.
"""

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


async def main(email: str, password: str, is_admin: bool, display_name: str | None) -> int:
    from app.core.database import init_pool, close_pool
    from app.services.auth_service import create_user, get_user_by_email

    await init_pool()
    try:
        if await get_user_by_email(email):
            print(f"User {email} already exists.")
            return 1
        user = await create_user(email, password, is_admin=is_admin, display_name=display_name)
        if not user:
            print(f"Failed to create user {email}.")
            return 1
        print(f"Created {'admin' if is_admin else 'user'} {email} uid={user['uid']}")
        return 0
    finally:
        await close_pool()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create a local app user")
    parser.add_argument("email")
    parser.add_argument("password")
    parser.add_argument("--admin", action="store_true", help="Grant admin privileges")
    parser.add_argument("--name", default=None, help="Display name")
    args = parser.parse_args()

    sys.exit(asyncio.run(main(args.email, args.password, args.admin, args.name)))
