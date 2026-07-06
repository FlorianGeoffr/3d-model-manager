# Build from the REPO ROOT: `docker build -f docker/Dockerfile .`
# (compose.yaml sets `context: .` / `dockerfile: docker/Dockerfile` for
# exactly this reason -- the image needs both backend/ and web/.)

# ---- Stage 1: build the frontend SPA ---------------------------------
FROM node:24-slim AS web-build

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 2: build gltfpack from source -------------------------------
# Source build, not the prebuilt gltfpack-ubuntu.zip release asset: that zip
# targets Ubuntu 24.04's glibc, which is newer than this image's bookworm
# base -- copying it in would fail to run at all. Building from source on
# the SAME base image as the runtime stage guarantees glibc compatibility
# and, as a bonus, covers arm64 too (the prebuilt zip is amd64-only).
FROM python:3.12-slim AS gltfpack-build

RUN apt-get update && apt-get install -y --no-install-recommends git cmake g++ make

RUN git clone --depth 1 --branch v1.2 https://github.com/zeux/meshoptimizer /src
RUN cmake -S /src -B /build -DMESHOPT_BUILD_GLTFPACK=ON -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build --target gltfpack -j

# ---- Stage 3: python runtime -------------------------------------------
FROM python:3.12-slim AS runtime

# uv is copied in as a static binary from its own distroless image (SPEC
# Task 9), not pip-installed.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# GL runtime libs (RESEARCH §4 / Global Constraints "Local prerequisites"):
# - libosmesa6 + libgl1-mesa-dri: f3d software rendering -- this container
#   has no GPU, so f3d renders via OSMesa (dev hosts instead use f3d's
#   EGL-offscreen fallback, see app/pipeline/render.py, and need neither).
#   f3d dlopens the UNVERSIONED "libOSMesa.so", which only ships in
#   libosmesa6-dev -- the symlink below supplies just that one name without
#   dragging in dev headers.
# - libgl1: OCP (cadquery-ocp) links against libGL.so.1 at import time,
#   which libgl1-mesa-dri alone does not provide (verified: without it,
#   `from OCP.BRep import ...` dies with "libGL.so.1: cannot open shared
#   object file" and takes the api/worker down at startup).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libosmesa6 libgl1-mesa-dri libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "/usr/lib/$(uname -m)-linux-gnu/libOSMesa.so.8" \
        "/usr/lib/$(uname -m)-linux-gnu/libOSMesa.so" \
    && ldconfig

COPY --from=gltfpack-build /build/gltfpack /usr/local/bin/gltfpack

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:${PATH}" \
    TDMM_STATIC_DIR=/app/static

WORKDIR /app

# Dependencies first, in their own layer, so editing app code doesn't
# invalidate the (slow) dependency install.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

# Now the rest of the backend (app/, alembic/, alembic.ini, ...).
# backend/tests and backend/tests_e2e are excluded from the build context
# entirely via .dockerignore -- they have no business in the runtime image.
COPY backend/ .

# The built SPA, served by app/static.py's SPA-fallback route.
COPY --from=web-build /web/dist ./static

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Runs as root (a deliberate M1 choice, not an oversight): the `local`
# storage backend writes into a bind-mounted host directory (./library),
# and root sidesteps a UID-mapping story for arbitrary host setups. Revisit
# if/when a deployment needs to drop privileges (e.g. multi-tenant hosting).

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
