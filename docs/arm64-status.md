# linux/arm64: why the published image is amd64-only

**Status as of 2026-07-19: blocked, on `f3d` and only `f3d`.**

`ghcr.io/metril/3d-model-manager` publishes `linux/amd64` only. The arm64
matrix entry in `.github/workflows/release.yml` is written out and commented,
so re-enabling it is a one-line uncomment — this document is the record of
what has to be true first, and of the research behind that decision, so nobody
has to redo it.

The release workflow deliberately keeps the build-by-digest + `imagetools`
manifest-merge topology even with a single-entry matrix, precisely so that
uncommenting is all it takes.

## The problem is dependency resolution, not build time

The intuition "arm64 builds are just slow under QEMU" is wrong here. Four of
this project's Python dependencies publish **x86_64-only wheels with no
source distribution at all**. With no sdist there is nothing for pip/uv to
fall back to and compile, so `uv sync --frozen` — the command
`docker/Dockerfile` runs to install the backend — does not build slowly on
aarch64. It **hard-fails immediately** with a "no matching distribution"
resolution error, before any compilation is attempted.

That failure mode is identical under emulation and on native ARM hardware.
QEMU does not help. A `ubuntu-24.04-arm` runner does not help. There is no
wheel to install and no source to build.

## Wheel availability

Checked against the exact versions pinned in `backend/uv.lock`:

| Package | Version | linux/aarch64 wheel | sdist fallback |
|---|---|---|---|
| `cadquery-ocp` | 7.9.3.1.1 | ✅ `manylinux_2_31_aarch64` | — |
| `manifold3d` | 3.5.2 | ✅ `manylinux_2_28_aarch64` | — |
| `trimesh` | 4.12.2 | ✅ pure-python | — |
| `cascadio` | 0.0.17 | ❌ (but `0.0.18rc6` **has** one) | ❌ none |
| `lib3mf` | 2.5.0 | ❌ | ❌ none |
| `embreex` | 4.4.0 (via `trimesh[easy]`) | ❌ | ❌ none |
| `f3d` | 3.5.0 | ❌ | ❌ none |

The three heavyweight CAD/mesh dependencies people expect to be the problem —
`cadquery-ocp` (OCCT), `manifold3d`, `trimesh` — already resolve on aarch64.
The blockers are the four smaller ones.

## The three cheap ones

**`cascadio`** — bump the pin to `>=0.0.18rc6`. Upstream builds it on a
native `ubuntu-24.04-arm` runner, and the published `0.0.18rc6` aarch64 wheel
was verified to contain a real aarch64 `_core.abi3.so` with OCCT 8.0.0
bundled, not a placeholder. This is a version bump and a `uv lock`, nothing
more.

**`lib3mf`** — buildable by hand. Its wheel declares `Root-Is-Purelib: true`:
the Python side is pure-python `ctypes` bindings, and the only native content
is a single 5.3 MB shared object whose entire dependency set is
`libstdc++`/`libm`/`libgcc`/`libc`. No OpenGL, no OCCT, nothing exotic.
conda-forge already ships `lib3mf` for `linux-aarch64`, which is direct
evidence the C++ side cross-compiles cleanly. The work is: cmake the upstream
library for aarch64, drop the resulting `.so` into the existing wheel layout,
and repack.

**`embreex`** — drop it. It arrives only through the `trimesh[easy]` extra and
is an optional ray-tracing accelerator. Depending on `trimesh` without
`[easy]` (plus the handful of extras actually used) removes it entirely.

## `f3d` is the real blocker

`f3d` 3.5.0's Linux wheel is a **157 MB single shared object**. It is built by
`f3d-superbuild`, which statically links VTK (pinned to a *master commit*,
not a tagged release), OCCT, Assimp, Mesa and LLVM into that one artifact.
There is no aarch64 wheel and no sdist. Reproducing the wheel for aarch64
means reproducing that entire superbuild, including a VTK built from an
unreleased commit.

Upstream tracking issue: <https://github.com/f3d-app/f3d/issues/3089>, opened
**2026-05-02** by maintainer **mwestphal**. Status is **"Discuss"**. As of
2026-07-19 it has **no comments, no linked PR and no timeline**, and — this is
the important part — it is scoped to the **f3d application binary**, not the
Python wheel this project depends on. Even if it lands, it does not
automatically produce what we need.

Waiting on upstream is therefore not a plan.

## The recommended fix: port `render.py` off f3d onto VTK

f3d is used in exactly one place. `backend/app/pipeline/render.py` exposes a
surface of **one module, two functions**: `_engine()` and `render_glb_png()`.
Nothing else in the backend imports `f3d`.

VTK is the natural target because it is **already in `backend/uv.lock`** —
version 9.6.2, pulled in transitively by `cadquery-ocp`. It costs nothing to
add. And unlike f3d, the VTK wheel **does** ship `manylinux_2_28_aarch64`,
with both `vtkOSOpenGLRenderWindow` and `vtkEGLRenderWindow` available. OSMesa
and EGL are `dlopen`'d at runtime rather than linked, which matches exactly
what `render.py` already assumes today: `_engine()` tries
`f3d.Engine.create_osmesa()` (the container path — the Docker image installs
`libosmesa6`) and falls back to `f3d.Engine.create(True)` for EGL offscreen.
The same two-path structure maps onto VTK's two render-window classes
directly.

### The honest caveat

f3d is not a thin wrapper around VTK. It does automatic camera framing, light
placement, and PBR/tone mapping — the things that make its default output look
good with no configuration. Raw VTK gives you none of that; you write it
yourself. Reproducing f3d's look closely enough is real, fiddly work, and any
result that isn't pixel-identical **changes the appearance of every existing
thumbnail in every deployed library**, which means shipping the port also
means shipping a re-render backfill for existing derivatives.

That is why the port is its own project and not a side-quest inside the CI/CD
work. It is a rendering change with a data migration attached, not a
packaging change.

## What would need to change to flip the matrix entry back on

All four, in order:

1. `f3d` publishes an aarch64 wheel **or** `render.py` is ported to VTK and the
   thumbnail backfill has shipped.
2. `cascadio` pinned to `>=0.0.18rc6` (or a later release carrying the aarch64
   wheel) and `backend/uv.lock` regenerated.
3. `lib3mf` resolves on aarch64 — upstream wheel, or a repacked one vendored
   into the image build.
4. `embreex` dropped from the dependency graph (stop using `trimesh[easy]`).

Then uncomment the `linux/arm64` entry in the `build` matrix in
`.github/workflows/release.yml`. Nothing else in the workflow needs to change:
the by-digest build and the `imagetools` merge already handle an n-entry
matrix, and `docker/Dockerfile` contains no architecture-specific logic.

Verify afterwards with:

```sh
docker buildx imagetools inspect ghcr.io/metril/3d-model-manager:latest
```

which should list both `linux/amd64` and `linux/arm64` platforms.

## How to re-check this cheaply

This snapshot goes stale. Rather than re-reading PyPI by hand, run this
against whatever is currently pinned in `backend/uv.lock` — it queries the
PyPI JSON API for each package at its locked version and reports whether any
Linux aarch64 wheel exists:

```sh
python3 - <<'PY'
import json, re, sys, urllib.error, urllib.request
from pathlib import Path

PACKAGES = ["cadquery-ocp", "manifold3d", "trimesh", "cascadio",
            "lib3mf", "embreex", "f3d", "vtk"]

lock = Path("backend/uv.lock").read_text()
# uv.lock is TOML: each [[package]] block has name/version on consecutive lines.
pinned = dict(re.findall(r'name = "([^"]+)"\nversion = "([^"]+)"', lock))

for pkg in PACKAGES:
    version = pinned.get(pkg)
    if version is None:
        print(f"{pkg:<14} not in uv.lock")
        continue
    url = f"https://pypi.org/pypi/{pkg}/{version}/json"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        print(f"{pkg:<14} {version:<12} PyPI lookup failed: {exc}")
        continue

    names = [f["filename"] for f in data["urls"]]
    # Exclude macOS: a macosx_11_0_arm64 wheel says nothing about Linux.
    aarch64 = [n for n in names
               if "aarch64" in n and "macosx" not in n]
    purelib = [n for n in names if n.endswith("-any.whl")]
    sdist = [n for n in names if n.endswith((".tar.gz", ".zip"))]

    if purelib:
        verdict = "OK  pure-python wheel"
    elif aarch64:
        verdict = f"OK  {aarch64[0]}"
    elif sdist:
        verdict = "??  no aarch64 wheel, but an sdist exists (may compile)"
    else:
        verdict = "NO  no aarch64 wheel and NO sdist -- hard resolution failure"
    print(f"{pkg:<14} {version:<12} {verdict}")
PY
```

Run it from the repository root. A package printing `NO` is a blocker; `??`
means it might build from source but the image build gets slower and may need
extra toolchain packages in `docker/Dockerfile`.

When the picture changes, update the table above, re-date this document, and
adjust the checklist.
