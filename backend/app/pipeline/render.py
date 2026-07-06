"""f3d-based headless mesh thumbnail rendering (SPEC pipeline rows 5-6;
RESEARCH §4's verified engine/options/render_to_image snippet).

Renders the raw, uncompressed ``glb`` DERIVATIVE ROW only -- never
``glb_web``/``glb_preview`` (Global Constraints "Two GLB artifacts per
blob": those are meshopt-compressed via gltfpack ``-cc``, and f3d -- like
trimesh/OCCT -- cannot read `EXT_meshopt_compression`/`KHR_mesh_quantization`
back). ``app.tasks.pipeline``'s ``render_thumb`` step and
``render_assembly_thumb`` task are the two callers.

Engine creation (Global Constraints "Local prerequisites"): ``create_osmesa()``
is the container path (Task 10's Docker image installs ``libosmesa6``);
``create(True)`` (EGL offscreen) is this project's verified dev-host
fallback -- neither a GPU/X server nor libosmesa6 is available locally, but
Mesa's EGL offscreen platform renders fine. Mesa prints ``libEGL warning:``
lines to stderr while probing render nodes it can't open -- expected noise,
not a bug (pytest captures it per-test). The engine is built once and cached
per worker process: creating a fresh one per render would be wasteful, and
the worker's memory-recycled ``cpu`` pool (SPEC "Architecture") bounds
whatever state accumulates in one across many renders.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import f3d

_RENDER_OPTIONS: dict[str, object] = {
    "ui.axis": False,
    "render.grid.enable": False,
    "render.effect.antialiasing.mode": "ssaa",
    "render.effect.ambient_occlusion": True,
}


@lru_cache
def _engine() -> f3d.Engine:
    """The process-wide cached f3d engine: OSMesa if available, else EGL
    offscreen. ``lru_cache`` (rather than a bare module global) gives this a
    single well-defined construction point that's also trivial to reset in
    tests (``_engine.cache_clear()``) if a test ever needs a fresh engine.
    """
    f3d.Engine.autoload_plugins()
    try:
        engine = f3d.Engine.create_osmesa()
    except Exception:
        engine = f3d.Engine.create(True)
    engine.options.update(_RENDER_OPTIONS)
    return engine


def render_glb_png(glb: Path, out_png: Path, size: int = 1024) -> None:
    """Render ``glb`` (a raw, uncompressed ``glb`` derivative or a merged
    assembly GLB) to a ``size`` x ``size`` PNG at ``out_png``, reusing the
    cached per-process engine.

    ``out_png``'s parent directory must already exist -- this is pure
    rendering, not derivative-store plumbing (callers stage/publish through
    ``app.services.derivatives`` themselves, exactly like every other step's
    tool invocation in this pipeline). The scene is cleared after every
    render (success or failure) so the next caller -- another blob's
    ``render_thumb`` step, or the assembly task's merged-scene render --
    starts from an empty scene rather than accumulating geometry.
    """
    engine = _engine()
    engine.scene.add(str(glb))
    try:
        engine.window.size = size, size
        engine.window.render_to_image(False).save(str(out_png))
    finally:
        engine.scene.clear()
