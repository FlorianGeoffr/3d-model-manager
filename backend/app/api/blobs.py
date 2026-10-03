"""Blob-derivative endpoints (Task 7 brief; Global Constraints "Derivative
store" / "Two GLB artifacts per blob"): immutable-cached thumbnails, GLBs,
and per-plate preview PNGs, served straight off the derivative store's
on-disk files -- no derivative bytes ever pass through the DB.
"""

import hashlib
import io
from enum import IntEnum
from pathlib import Path

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi import Path as FastPath
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.models import Blob, Derivative, File
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.services import derivatives, spool
from app.services.storage_backends import resolve_backend_for_file

router = APIRouter(prefix="/blobs", tags=["blobs"])

_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


class ThumbSize(IntEnum):
    """``size=256|1024`` (Task 7 brief). A plain ``Literal[256, 1024]`` query
    param doesn't coerce a query string ("1024") to the matching int member
    on this FastAPI/Pydantic version -- an ``IntEnum`` does, while still
    422ing on any other value.
    """

    SMALL = 256
    LARGE = 1024


def _if_none_match_matches(request: Request, quoted_etag: str) -> bool:
    """``If-None-Match`` may carry a comma-separated list of validators
    (RFC 7232 SS3.2), any of which can be weak (``W/"..."``-prefixed) -- a
    client revalidating several cached representations (e.g. after the
    ``size``/``preview`` query param changed) sends its whole list on one
    request. A strict single-value string compare only matched when the
    right entry happened to be first (M2-Minor 4 fold).
    """
    header = request.headers.get("if-none-match")
    if not header:
        return False
    return any(
        candidate.strip().removeprefix("W/") == quoted_etag for candidate in header.split(",")
    )


async def _conditional_file_response(
    request: Request,
    path,
    etag: str,
    media_type: str,
    *,
    cache_control: str,
    missing_detail: str = DerivativeStatus.PENDING.value,
) -> Response:
    quoted_etag = f'"{etag}"'
    headers = {"Cache-Control": cache_control, "ETag": quoted_etag}
    if _if_none_match_matches(request, quoted_etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    exists = await anyio.to_thread.run_sync(path.exists)
    if not exists:
        # The DB says `ok`, but the file is gone (e.g. removed out of band)
        # -- an inconsistent state, but a clean 404 beats `FileResponse`
        # raising a raw 500 at send time (M2-Minor 4 fold; matches
        # app.api.revisions.get_assembly_thumb's existing handling).
        raise HTTPException(status.HTTP_404_NOT_FOUND, missing_detail)
    return FileResponse(path, media_type=media_type, headers=headers)


async def _get_blob_or_404(db: AsyncSession, blob_hash: str) -> Blob:
    blob = await db.get(Blob, blob_hash)
    if blob is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "blob not found")
    return blob


async def _get_derivative(
    db: AsyncSession, blob_hash: str, kind: DerivativeKind
) -> Derivative | None:
    return await db.scalar(
        select(Derivative).where(Derivative.blob_hash == blob_hash, Derivative.kind == kind)
    )


def _not_ready_detail(deriv: Derivative | None) -> str:
    """A missing row means the step hasn't run yet -- same client-facing
    story as an explicit ``pending`` status.
    """
    return deriv.status.value if deriv is not None else DerivativeStatus.PENDING.value


def _generate_and_save_image_thumbs(
    raw_bytes: bytes, settings: Settings, blob_hash: str, kind: DerivativeKind
) -> Path | None:
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(raw_bytes)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode == "RGBA" or (img.mode == "P" and "transparency" in img.info):
                img = img.convert("RGBA")
            elif img.mode != "RGB":
                img = img.convert("RGB")

            p1024 = derivatives.derivative_path(settings, blob_hash, DerivativeKind.THUMB_1024)
            p256 = derivatives.derivative_path(settings, blob_hash, DerivativeKind.THUMB_256)

            im1024 = img.copy()
            im1024.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            buf1024 = io.BytesIO()
            im1024.save(buf1024, format="PNG")
            derivatives.publish_bytes(buf1024.getvalue(), p1024)

            im256 = img.copy()
            im256.thumbnail((256, 256), Image.Resampling.LANCZOS)
            buf256 = io.BytesIO()
            im256.save(buf256, format="PNG")
            derivatives.publish_bytes(buf256.getvalue(), p256)

            return p256 if kind == DerivativeKind.THUMB_256 else p1024
    except Exception:
        return None


def _extract_and_save_3mf_thumb(
    raw_bytes: bytes, settings: Settings, blob_hash: str, kind: DerivativeKind
) -> Path | None:
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
            names = ("Metadata/thumbnail.png", "3D/Metadata/plate_1.png", "Metadata/plate_1.png")
            for name in names:
                if name in zf.namelist():
                    data = zf.read(name)
                    return _generate_and_save_image_thumbs(data, settings, blob_hash, kind)
    except Exception:
        pass
    return None


async def _get_blob_raw_bytes(db: AsyncSession, settings: Settings, blob_hash: str) -> bytes | None:
    files = (
        (
            await db.execute(
                select(File)
                .where(File.blob_hash == blob_hash)
                .order_by(File.verified_at.desc().nullslast(), File.id)
            )
        )
        .scalars()
        .all()
    )
    for file in files:
        try:
            backend = await resolve_backend_for_file(db, settings, file)

            def _read_all(b=backend, sp=file.storage_path) -> bytes:
                return b"".join(b.read(sp))

            data = await anyio.to_thread.run_sync(_read_all)
            if data:
                return data
        except Exception:
            pass

    # Check spool directory for in-flight uploads
    try:
        spool_d = spool.spool_dir(settings)
        if await anyio.to_thread.run_sync(spool_d.is_dir):

            def _check_spool() -> bytes | None:
                for p in spool_d.iterdir():
                    if p.is_file():
                        try:
                            content = p.read_bytes()
                            if hashlib.sha256(content).hexdigest() == blob_hash:
                                return content
                        except Exception:
                            pass
                return None

            res = await anyio.to_thread.run_sync(_check_spool)
            if res is not None:
                return res
    except Exception:
        pass

    return None


@router.get("/{blob_hash}/thumb")
async def get_blob_thumb(
    blob_hash: str,
    request: Request,
    size: int = 256,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    blob = await _get_blob_or_404(db, blob_hash)
    kind = DerivativeKind.THUMB_256 if int(size) <= 256 else DerivativeKind.THUMB_1024

    # 1. If the requested derivative already exists on disk, serve it immediately.
    path = derivatives.derivative_path(settings, blob_hash, kind)
    if await anyio.to_thread.run_sync(path.is_file):
        return await _conditional_file_response(
            request,
            path,
            f"{blob_hash}:{kind.value}",
            "image/png",
            cache_control=_IMMUTABLE_CACHE_CONTROL,
        )

    # 2. For image blobs: generate thumbnail on-demand using Pillow and serve it.
    is_image = blob.kind == BlobKind.IMAGE or blob.format in (
        BlobFormat.PNG,
        BlobFormat.JPG,
        BlobFormat.WEBP,
    )
    if is_image:
        raw_bytes = await _get_blob_raw_bytes(db, settings, blob_hash)
        if raw_bytes is not None:
            thumb_path = await anyio.to_thread.run_sync(
                _generate_and_save_image_thumbs, raw_bytes, settings, blob_hash, kind
            )
            if thumb_path is not None and await anyio.to_thread.run_sync(thumb_path.is_file):
                try:
                    deriv_row = await _get_derivative(db, blob_hash, kind)
                    if deriv_row is None:
                        db.add(
                            Derivative(
                                blob_hash=blob_hash,
                                kind=kind,
                                status=DerivativeStatus.OK,
                                local_path=str(thumb_path),
                                tool="pillow_ondemand",
                            )
                        )
                    else:
                        deriv_row.status = DerivativeStatus.OK
                        deriv_row.local_path = str(thumb_path)
                        deriv_row.tool = "pillow_ondemand"
                    await db.commit()
                except Exception:
                    pass
                return await _conditional_file_response(
                    request,
                    thumb_path,
                    f"{blob_hash}:{kind.value}",
                    "image/png",
                    cache_control=_IMMUTABLE_CACHE_CONTROL,
                )

            # Fallback: serve raw image directly
            quoted_etag = f'"{blob_hash}:raw"'
            headers = {"Cache-Control": _IMMUTABLE_CACHE_CONTROL, "ETag": quoted_etag}
            if _if_none_match_matches(request, quoted_etag):
                return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
            media_type = "image/png"
            if blob.format == BlobFormat.JPG:
                media_type = "image/jpeg"
            elif blob.format == BlobFormat.WEBP:
                media_type = "image/webp"
            return Response(
                content=raw_bytes,
                media_type=media_type,
                headers={**headers, "Content-Length": str(len(raw_bytes))},
            )

    # 3. For 3MF/gcode.3mf blobs: extract embedded thumbnail on-demand if available.
    if blob.format in (BlobFormat.THREEMF, BlobFormat.GCODE_3MF):
        try:
            raw_bytes = await _get_blob_raw_bytes(db, settings, blob_hash)
            if raw_bytes is not None:
                thumb_path = await anyio.to_thread.run_sync(
                    _extract_and_save_3mf_thumb, raw_bytes, settings, blob_hash, kind
                )
                if thumb_path is not None and await anyio.to_thread.run_sync(thumb_path.is_file):
                    return await _conditional_file_response(
                        request,
                        thumb_path,
                        f"{blob_hash}:{kind.value}",
                        "image/png",
                        cache_control=_IMMUTABLE_CACHE_CONTROL,
                    )
        except Exception:
            pass

    # 4. If alternate size is available on disk, serve it.
    alt_kind = (
        DerivativeKind.THUMB_1024 if kind == DerivativeKind.THUMB_256 else DerivativeKind.THUMB_256
    )
    alt_path = derivatives.derivative_path(settings, blob_hash, alt_kind)
    if await anyio.to_thread.run_sync(alt_path.is_file):
        return await _conditional_file_response(
            request,
            alt_path,
            f"{blob_hash}:{alt_kind.value}",
            "image/png",
            cache_control=_IMMUTABLE_CACHE_CONTROL,
        )

    deriv = await _get_derivative(db, blob_hash, kind)
    raise HTTPException(status.HTTP_404_NOT_FOUND, _not_ready_detail(deriv))


@router.get("/{blob_hash}/plates/{index}/thumb")
async def get_blob_plate_thumb(
    blob_hash: str,
    request: Request,
    index: int = FastPath(ge=1),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    await _get_blob_or_404(db, blob_hash)
    path = derivatives.plate_thumb_path(settings, blob_hash, index)

    return await _conditional_file_response(
        request,
        path,
        f"{blob_hash}:plate{index}",
        "image/png",
        cache_control=_IMMUTABLE_CACHE_CONTROL,
        missing_detail="plate thumbnail not found",
    )


@router.get("/{blob_hash}/glb")
async def get_blob_glb(
    blob_hash: str,
    request: Request,
    preview: bool = False,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Serves the meshopt-compressed browser GLB when it exists, else the
    raw uncompressed ``glb`` derivative -- see Global Constraints "Two GLB
    artifacts per blob". ``preview=true`` prefers the decimated LOD when
    it's ``ok``, falling through to the same raw-glb-then-web chain
    otherwise (Task 7 interface decision).
    """
    await _get_blob_or_404(db, blob_hash)

    if preview:
        preview_deriv = await _get_derivative(db, blob_hash, DerivativeKind.GLB_PREVIEW)
        if preview_deriv is not None and preview_deriv.status == DerivativeStatus.OK:
            path = derivatives.derivative_path(settings, blob_hash, DerivativeKind.GLB_PREVIEW)
            return await _conditional_file_response(
                request,
                path,
                f"{blob_hash}:glb_preview",
                "model/gltf-binary",
                cache_control=_IMMUTABLE_CACHE_CONTROL,
            )

    raw_deriv = await _get_derivative(db, blob_hash, DerivativeKind.GLB)
    if raw_deriv is None or raw_deriv.status != DerivativeStatus.OK:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _not_ready_detail(raw_deriv))

    web_path = derivatives.glb_web_path(settings, blob_hash)
    web_exists = await anyio.to_thread.run_sync(web_path.exists)
    path = (
        web_path
        if web_exists
        else derivatives.derivative_path(settings, blob_hash, DerivativeKind.GLB)
    )

    return await _conditional_file_response(
        request,
        path,
        f"{blob_hash}:glb",
        "model/gltf-binary",
        cache_control=_IMMUTABLE_CACHE_CONTROL,
    )
