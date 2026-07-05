"""First-run admin bootstrap (SPEC requirement 1: single admin account).

Called from the app lifespan (``app.main``) so it runs once per process
startup. Lives here rather than inline in ``main.py`` so the same logic can
be reused by the Celery worker process added in a later task, which needs
an equivalent async-context entry point but no FastAPI app around it.
"""

import logging
import secrets

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import User
from app.security import hash_password

logger = logging.getLogger(__name__)

# token_urlsafe(24) always yields exactly 32 base64url characters (24 is a
# multiple of 3, so there's no padding to strip), comfortably over the
# "24+ char" floor.
_GENERATED_PASSWORD_BYTES = 24


async def ensure_admin_user(session: AsyncSession) -> None:
    """Create the single admin user if no user exists yet.

    Idempotent: a no-op once any user row exists, so it's safe to call on
    every startup without ever creating a second account.
    """
    user_count = await session.scalar(select(func.count()).select_from(User))
    if user_count:
        return

    settings = get_settings()
    password = settings.admin_password
    generated = password is None
    if generated:
        password = secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES)

    user = User(username=settings.admin_username, password_hash=hash_password(password))
    session.add(user)
    await session.commit()

    if generated:
        logger.warning(
            "\n"
            + "=" * 72
            + "\nNo TDMM_ADMIN_PASSWORD set - generated a random admin password.\n"
            + f"    username: {settings.admin_username}\n"
            + f"    password: {password}\n"
            + "This password is shown ONLY this once and is not recoverable; save it now.\n"
            + "=" * 72
        )
