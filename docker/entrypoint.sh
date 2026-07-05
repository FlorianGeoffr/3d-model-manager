#!/usr/bin/env bash
# Container entrypoint: switches on TDMM_ROLE (SPEC "Architecture" -- one
# shared image, two entrypoints in M1; `printerd` is M4).
set -euo pipefail

case "${TDMM_ROLE:-api}" in
  api)
    echo "[entrypoint] running database migrations..."
    alembic upgrade head
    echo "[entrypoint] starting API server..."
    exec uvicorn app.main:app --host 0.0.0.0 --port 8080
    ;;
  worker)
    echo "[entrypoint] starting Celery worker (queues: io, cpu)..."
    exec celery -A app.tasks.celery_app worker -Q io,cpu --concurrency=2 -l info
    ;;
  *)
    echo "[entrypoint] unknown TDMM_ROLE=${TDMM_ROLE:-<unset>} (expected 'api' or 'worker')" >&2
    exit 1
    ;;
esac
