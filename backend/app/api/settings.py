"""Storage settings API (Task 6 brief; Global Constraints "New endpoint
verbs"): read/set the active storage backend config (secrets redacted on
read), a connection-test probe against a candidate config, and the
migration-helper job that copies the whole library tree onto a new backend
before cutting over.

``PUT`` is a *direct* set -- for pointing at an already-populated or empty
backend with no copy needed. The safe "copy the existing library across,
verify, then cut over" path is ``POST /migrate`` (``app.tasks.migrate``).
"""

from __future__ import annotations

import uuid

import anyio
import pydantic
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.imports import ImportTokensIn, ImportTokensOut
from app.schemas.jobs import JobOut
from app.schemas.settings import (
    BambuLoginIn,
    BambuLoginOut,
    BambuStatusOut,
    BambuVerifyIn,
    ConnectionTestOut,
    StorageConfigIn,
    StorageConfigOut,
)
from app.services import bambu_auth, import_tokens, storage_config
from app.services import jobs as jobs_service
from app.services.storage_probe import probe_backend
from app.storage.config import SECRET_FIELD_BY_BACKEND, StorageConfig, parse_storage_config
from app.storage.registry import get_backend
from app.tasks.migrate import migrate_storage

router = APIRouter(prefix="/settings", tags=["settings"])

# Redaction sentinel GET emits for a set secret (app.storage.config.redacted)
# -- an incoming request carrying this literal value is read back verbatim
# from a form the client seeded off a redacted GET, never a real secret.
_REDACTED_SENTINEL = "***"


def _parse(backend: str, config: dict) -> StorageConfig:
    """Validate the flat ``{backend, config}`` request shape into the
    matching per-backend pydantic model.

    ``parse_storage_config`` is called directly against a hand-built dict
    here (not through FastAPI's own request-body validation), so a bad or
    incomplete config raises a plain ``pydantic.ValidationError`` rather than
    the ``RequestValidationError`` FastAPI auto-converts to 422 -- translate
    it by hand so an invalid config still 422s instead of 500ing.
    """
    try:
        return parse_storage_config({**config, "backend": backend})
    except pydantic.ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


async def _merge_stored_secrets(
    db: AsyncSession, settings: Settings, backend: str, config: dict
) -> dict:
    """Fill in the stored secret when the incoming one is missing, blank, or
    the ``"***"`` redaction sentinel GET always returns for a set secret.

    The frontend never has the real secret to send back (GET redacts it), so
    editing an already-configured SMB/S3 backend's OTHER fields -- or
    testing/migrating against the currently-active backend -- would
    otherwise 422 (validation) or silently persist the literal ``"***"`` as
    the "secret". Substituting only kicks in when the currently-stored
    active config is the SAME backend type and actually has a secret set; a
    genuinely blank secret with nothing of that backend type stored is left
    alone so ``_parse`` still 422s on it (a real error, not this case).

    The ``"***"`` sentinel itself must never be accepted as a real secret,
    though: if there's no stored secret to substitute (different backend
    type currently active, or the same type but no secret set), reject with
    422 instead of letting the literal placeholder fall through to
    ``_parse`` and get persisted as the "secret".

    Never widens what a caller can learn: this only feeds a value back into
    server-side validation/backend construction, it never appears in a
    response (GET/PUT responses go through ``redacted()``).
    """
    secret_field = SECRET_FIELD_BY_BACKEND.get(backend)
    if secret_field is None:
        return config
    incoming = config.get(secret_field) or ""
    if incoming not in ("", _REDACTED_SENTINEL):
        return config
    stored = await storage_config.get_active_config(db, settings)
    # `stored`'s secret field is a `SecretStr` (M6 A2/T3), whose truthiness is
    # ALWAYS True -- even for `SecretStr("")`. Unwrap to the plain value and
    # gate on THAT, so a stored EMPTY secret doesn't masquerade as "present"
    # (which would skip the `"***"`-sentinel 422 below) and so the merged
    # dict carries a plain str -- matching the incoming JSON config -- into
    # `_parse`, never a stray `SecretStr` (M6-MINOR-1).
    stored_secret = getattr(stored, secret_field, None) if stored.backend == backend else None
    stored_value = stored_secret.get_secret_value() if stored_secret is not None else ""
    if stored_value:
        return {**config, secret_field: stored_value}
    if incoming == _REDACTED_SENTINEL:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f'Cannot set {secret_field!r} to the redaction placeholder "***"; '
            "enter the real secret.",
        )
    return config


@router.get("/storage", response_model=StorageConfigOut)
async def get_storage_settings(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> StorageConfigOut:
    config = await storage_config.get_active_config(db, settings)
    return StorageConfigOut.from_config(config)


@router.put("/storage", response_model=StorageConfigOut)
async def put_storage_settings(
    payload: StorageConfigIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> StorageConfigOut:
    merged = await _merge_stored_secrets(db, settings, payload.backend, payload.config)
    config = _parse(payload.backend, merged)
    await storage_config.set_active_config(db, settings, config)
    return StorageConfigOut.from_config(config)


@router.post("/storage/test", response_model=ConnectionTestOut)
async def test_storage_settings(
    payload: StorageConfigIn,
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> ConnectionTestOut:
    merged = await _merge_stored_secrets(db, settings, payload.backend, payload.config)
    config = _parse(payload.backend, merged)
    backend = get_backend(settings, config)
    ok, detail, latency_ms = await anyio.to_thread.run_sync(probe_backend, backend)
    return ConnectionTestOut(ok=ok, detail=detail, latency_ms=latency_ms)


@router.post("/storage/migrate", response_model=JobOut)
async def migrate_storage_settings(
    payload: StorageConfigIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> JobOut:
    merged = await _merge_stored_secrets(db, settings, payload.backend, payload.config)
    config = _parse(payload.backend, merged)
    job = await jobs_service.create_job(
        db, id=uuid.uuid4(), type="migrate_storage", subject_type=None, subject_id=None
    )

    # The target config travels over the internal Celery broker -- encrypt
    # its secret field on the wire (M6 A1.5.2), same as it's encrypted at
    # rest; migrate_storage decrypts it at the top of the task.
    migrate_storage.apply_async(
        args=[str(job.id), storage_config.encrypt_config_secret(settings, config)],
        task_id=str(job.id),
    )

    # Under the test suite's eager Celery mode, the line above already ran
    # the whole migration inline through its own SYNC session -- refresh so
    # this (separate, async) session's identity map doesn't hand back the
    # stale "queued" snapshot from right after the insert (same reasoning as
    # app.api.scan.trigger_scan).
    await db.refresh(job)
    return JobOut.from_model(job)


@router.get("/import-tokens", response_model=ImportTokensOut)
async def get_import_tokens_settings(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> ImportTokensOut:
    tokens = await import_tokens.get_import_tokens(db, settings)
    return ImportTokensOut(thingiverse_token=_REDACTED_SENTINEL if tokens.thingiverse_token else "")


@router.put("/import-tokens", response_model=ImportTokensOut)
async def put_import_tokens_settings(
    payload: ImportTokensIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ImportTokensOut:
    """Merge-on-blank/sentinel, mirroring ``_merge_stored_secrets``: a blank
    or ``"***"`` submit keeps the stored token; a bare ``"***"`` with nothing
    stored is rejected 422 (never persist the placeholder as a credential);
    a real value replaces it."""
    incoming = (payload.thingiverse_token or "").strip()
    stored = (await import_tokens.get_import_tokens(db, settings)).thingiverse_token or ""
    if incoming in ("", _REDACTED_SENTINEL):
        if stored:
            value: str | None = stored
        elif incoming == _REDACTED_SENTINEL:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                'Cannot set the token to the redaction placeholder "***"; enter the real token.',
            )
        else:
            value = None  # explicit clear when nothing stored + blank submit
    else:
        value = incoming
    await import_tokens.set_thingiverse_token(db, settings, value)
    return ImportTokensOut(thingiverse_token=_REDACTED_SENTINEL if value else "")


# ---------------------------------------------------------------------------
# Bambu Lab account connect flow (Workstream B task B2). Unlike the storage/
# import-token settings above, this isn't a raw PUT of an operator-typed
# secret -- login/verify each make a real outbound call to Bambu
# (app.services.bambu_auth), so they run the blocking httpx client on a
# worker thread via anyio.to_thread.run_sync (same pattern as
# test_storage_settings' probe_backend call). No response here EVER carries
# a token (see BambuLoginOut/BambuStatusOut) -- only "connected"/"mfa_
# required" plus the account/region the operator already knows.
# ---------------------------------------------------------------------------


@router.get("/bambu", response_model=BambuStatusOut)
async def get_bambu_status(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> BambuStatusOut:
    state = await bambu_auth.get_bambu_auth(db, settings)
    return BambuStatusOut(
        connected=bool(state.refresh_token), account=state.account, region=state.region
    )


@router.post("/bambu/login", response_model=BambuLoginOut)
async def post_bambu_login(
    payload: BambuLoginIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> BambuLoginOut:
    try:
        result = await anyio.to_thread.run_sync(
            bambu_auth.login, payload.account, payload.password, payload.region
        )
    except bambu_auth.BambuAuthError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if result.status == "connected":
        await bambu_auth.set_bambu_auth(
            db,
            settings,
            account=payload.account,
            region=payload.region,
            refresh_token=result.refresh_token or "",
        )
        return BambuLoginOut(status="connected", account=payload.account, region=payload.region)
    return BambuLoginOut(
        status="mfa_required",
        account=payload.account,
        region=payload.region,
        mfa_context=result.mfa_context,
    )


@router.post("/bambu/verify", response_model=BambuLoginOut)
async def post_bambu_verify(
    payload: BambuVerifyIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> BambuLoginOut:
    try:
        result = await anyio.to_thread.run_sync(
            bambu_auth.verify_code,
            payload.account,
            payload.code,
            payload.region,
            payload.mfa_context,
        )
    except bambu_auth.BambuAuthError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await bambu_auth.set_bambu_auth(
        db,
        settings,
        account=payload.account,
        region=payload.region,
        refresh_token=result.refresh_token or "",
    )
    return BambuLoginOut(status="connected", account=payload.account, region=payload.region)


@router.delete("/bambu", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bambu_auth(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> None:
    await bambu_auth.clear_bambu_auth(db, settings)
