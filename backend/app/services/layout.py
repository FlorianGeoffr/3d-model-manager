"""Library storage layout: slugs, revision directory names, and the
model-level ``.3dmm.json`` sidecar (SPEC "Storage layer", "Path layout").

Kept free of DB access -- slug *uniqueness* (which needs a DB round trip)
lives in ``app.services.library``; this module only computes the
deterministic strings the SPEC layout is built from, plus the small
synchronous sidecar write (called via ``anyio.to_thread.run_sync`` by
callers, per ``app.storage.base``'s threading rule).
"""

from __future__ import annotations

import json

from slugify import slugify

from app.storage.base import StorageBackend

# Sidecar filename, per SPEC "Path layout": `<slug>/.3dmm.json`.
SIDECAR_NAME = ".3dmm.json"


def slug_for(name: str) -> str:
    """Base slug candidate for a model name (before uniquification)."""
    return slugify(name) or "model"


def revision_dir_name(number: int, name: str | None) -> str:
    """Directory name for a revision, e.g. ``rev-003_added-drain-holes``.

    Falls back to the literal ``rev`` suffix when ``name`` is absent or
    slugifies to nothing (SPEC Task 5: "dir_name rev-{n:03d}_{slugified-
    name-or-'rev'}").
    """
    suffix = slugify(name) if name else ""
    return f"rev-{number:03d}_{suffix or 'rev'}"


def revision_dir_key(slug: str, dir_name: str) -> str:
    """Storage key for a revision's directory."""
    return f"{slug}/{dir_name}"


def file_key(slug: str, dir_name: str, rel_path: str) -> str:
    """Storage key for a file within a revision's directory."""
    return f"{slug}/{dir_name}/{rel_path}"


def sidecar_key(slug: str) -> str:
    """Storage key for a model's ``.3dmm.json`` sidecar."""
    return f"{slug}/{SIDECAR_NAME}"


def sidecar_content(model_id: int, slug: str, name: str) -> dict[str, object]:
    """The sidecar's JSON body (SPEC: ``{model_id, slug, name}``)."""
    return {"model_id": model_id, "slug": slug, "name": name}


def write_sidecar(backend: StorageBackend, model_id: int, slug: str, name: str) -> None:
    """Write the ``.3dmm.json`` sidecar for a model. Synchronous -- call via
    ``anyio.to_thread.run_sync``.
    """
    payload = json.dumps(sidecar_content(model_id, slug, name)).encode()
    backend.write(sidecar_key(slug), [payload])
