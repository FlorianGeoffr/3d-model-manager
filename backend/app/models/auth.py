"""Auth domain: ``users``, ``sessions`` (SPEC "Data model")."""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Identity, String, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    """Single-admin account (SPEC requirement 1: username/password session)."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)


class Session(Base):
    """Cookie-backed login session, keyed by the token itself (SPEC:
    ``sessions(id uuid=cookie token, user_id, created_at, expires_at,
    last_seen_at)``).
    """

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)


class ApiToken(Base):
    """Bearer token for the browser-extension auth plane (M10 Workstream A),
    separate from the cookie session above -- a browser extension browsing a
    gallery site can't present ``tdmm_session`` (samesite=lax, cross-site, no
    CORS), so it authenticates with one of these instead. Only the SHA-256
    hash is stored (see ``app.services.api_tokens`` for why a fast hash is
    the right call here, unlike the argon2id used for the human password);
    the plaintext token is generated once at mint time and never persisted.
    """

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)
