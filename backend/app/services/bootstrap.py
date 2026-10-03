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
    configured = settings.admin_password
    generated = configured is None
    password = (
        secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES)
        if generated
        else configured.get_secret_value()
    )

    user = User(username=settings.admin_username, password_hash=hash_password(password))
    session.add(user)
    await session.commit()

    if generated:
        logger.warning(
            "\n"
            + "=" * 72
            + "\nNo ADMIN_PASSWORD set - generated a random admin password.\n"
            + f"    username: {settings.admin_username}\n"
            + f"    password: {password}\n"
            + "This password is shown ONLY this once and is not recoverable; save it now.\n"
            + "=" * 72
        )


async def heal_failed_scad_derivatives(session: AsyncSession) -> None:
    """Find SCAD blobs whose GLB derivative failed (e.g. from headless environment
    issues prior to xvfb support), delete the failed derivative rows, and re-enqueue
    the pipeline so previews and thumbnails are regenerated.
    """
    import uuid

    from app.models import Blob, Derivative, File
    from app.models.enums import BlobFormat, DerivativeKind, DerivativeStatus
    from app.services import jobs as jobs_service
    from app.tasks.pipeline import STEP_TASKS

    stmt = (
        select(Derivative)
        .join(Blob, Blob.hash == Derivative.blob_hash)
        .where(
            Blob.format == BlobFormat.SCAD,
            Derivative.kind == DerivativeKind.GLB,
            Derivative.status == DerivativeStatus.FAILED,
        )
    )
    failed_scads = list((await session.execute(stmt)).scalars().all())
    if not failed_scads:
        return

    logger.info("Auto-healing %d failed SCAD GLB derivative(s)", len(failed_scads))
    task = STEP_TASKS.get("convert_to_glb")

    for deriv in failed_scads:
        blob_hash = deriv.blob_hash
        # Delete failed derivative rows for this blob so it can be cleanly rebuilt
        all_failed_stmt = select(Derivative).where(
            Derivative.blob_hash == blob_hash,
            Derivative.status == DerivativeStatus.FAILED,
        )
        all_failed = list((await session.execute(all_failed_stmt)).scalars().all())
        for f_deriv in all_failed:
            await session.delete(f_deriv)

        # Find file referencing this blob
        file_stmt = select(File).where(File.blob_hash == blob_hash)
        file_row = (await session.execute(file_stmt)).scalars().first()
        if file_row and task:
            job_id = uuid.uuid4()
            try:
                await jobs_service.create_job(
                    session,
                    id=job_id,
                    type="convert_to_glb",
                    subject_type="file",
                    subject_id=file_row.id,
                )
                task.apply_async(args=[str(job_id), blob_hash], task_id=str(job_id))
                logger.info(
                    "Enqueued convert_to_glb job %s for healed SCAD blob %s", job_id, blob_hash
                )
            except Exception as exc:
                logger.warning("Could not dispatch heal job for blob %s: %s", blob_hash, exc)

    await session.commit()
