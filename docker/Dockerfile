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

# ---- Stage 2: python runtime -------------------------------------------
FROM python:3.12-slim AS runtime

# uv is copied in as a static binary from its own distroless image (SPEC
# Task 9), not pip-installed.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

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
