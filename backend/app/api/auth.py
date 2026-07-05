"""Login/logout/me (SPEC requirement 1, "API surface" auth rows).

Split into two routers: ``public_router`` (just ``/auth/login``, which must
stay reachable without a session) and ``protected_router`` (``/auth/me``,
``/auth/logout``), mirroring the split enforced at ``app.api`` level.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SESSION_COOKIE_NAME, SESSION_MAX_AGE, AuthContext, require_session
from app.config import get_settings
from app.db import get_db
from app.models import Session as SessionModel
from app.models import User
from app.security import DUMMY_HASH, verify_password

public_router = APIRouter(prefix="/auth", tags=["auth"])
protected_router = APIRouter(prefix="/auth", tags=["auth"])

# ``me``/``logout`` below also declare `Depends(require_session)` themselves
# even though the *enforcement* already happens once via the router-level
# dependency composed in ``app.api`` -- that's what's needed to get the
# resolved ``AuthContext`` value into the handler. FastAPI caches a
# dependency's result per request by callable identity, so this doesn't run
# ``require_session`` (and its DB query) twice.


class LoginRequest(BaseModel):
    username: str
    password: str


def _invalid_credentials() -> HTTPException:
    """One message for both "no such user" and "wrong password" so a login
    attempt can never be used to enumerate valid usernames.
    """
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid username or password",
    )


@public_router.post("/login", status_code=status.HTTP_204_NO_CONTENT)
async def login(
    payload: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Verify credentials, open a session, and set the session cookie."""
    user = (
        await db.execute(select(User).where(User.username == payload.username))
    ).scalar_one_or_none()

    if user is None:
        # Still pay the cost of a real argon2 verification so this branch
        # takes roughly as long as the wrong-password branch below (see
        # app.security.DUMMY_HASH).
        verify_password(payload.password, DUMMY_HASH)
        raise _invalid_credentials()

    if not verify_password(payload.password, user.password_hash):
        raise _invalid_credentials()

    session = SessionModel(user_id=user.id, expires_at=datetime.now(UTC) + SESSION_MAX_AGE)
    db.add(session)
    await db.commit()

    settings = get_settings()
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=str(session.id),
        max_age=int(SESSION_MAX_AGE.total_seconds()),
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


@protected_router.get("/me")
async def me(ctx: AuthContext = Depends(require_session)) -> dict[str, str]:
    """Return the authenticated user's username."""
    return {"username": ctx.user.username}


@protected_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    ctx: AuthContext = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Invalidate the current session and clear the cookie."""
    await db.delete(ctx.session)
    await db.commit()

    settings = get_settings()
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )
