#!/usr/bin/env bash
# Container entrypoint: switches on TDMM_ROLE (SPEC "Architecture" -- one
# shared image, two entrypoints in M1; `printerd` is M4).
set -euo pipefail

# Optional privilege drop (linuxserver.io convention). Root is still the
# default: set PUID/PGID to run the api/worker as a specific host uid/gid
# so bind-mounted ./library files aren't root-owned. Re-exec guard avoids
# an infinite loop.
if [[ -z "${TDMM_PRIVDROP_DONE:-}" && ( -n "${PUID:-}" || -n "${PGID:-}" ) ]]; then
  PUID="${PUID:-1000}"; PGID="${PGID:-1000}"
  groupmod -o -g "$PGID" tdmm 2>/dev/null || groupadd -o -g "$PGID" tdmm
  usermod  -o -u "$PUID" -g "$PGID" tdmm 2>/dev/null || useradd -o -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin tdmm
  chown -R tdmm:tdmm /data /library 2>/dev/null || true
  export TDMM_PRIVDROP_DONE=1
  exec gosu tdmm:tdmm "$0" "$@"
fi

# Explicit command override (e.g. `celery ... beat` for the optional
# scheduled-scan service, or the PUID/PGID smoke check in the README) --
# skips the TDMM_ROLE routing below and runs the given command directly,
# as whichever user the privilege drop above landed on (root by default).
if [[ $# -gt 0 ]]; then
  exec "$@"
fi

case "${TDMM_ROLE:-api}" in
  api)
    echo "[entrypoint] running database migrations..."
    alembic upgrade head
    echo "[entrypoint] starting API server..."
    exec uvicorn app.main:app --host 0.0.0.0 --port 8080
    ;;
  worker)
    echo "[entrypoint] starting Celery worker (queues: ${TDMM_QUEUES:-io,cpu})..."
    ARGS=(-Q "${TDMM_QUEUES:-io,cpu}" -l info)
    [[ -n "${TDMM_CONCURRENCY:-}" ]] && ARGS+=(--concurrency="${TDMM_CONCURRENCY}")
    [[ -n "${TDMM_MAX_TASKS_PER_CHILD:-}" ]] && ARGS+=(--max-tasks-per-child="${TDMM_MAX_TASKS_PER_CHILD}")
    [[ -n "${TDMM_MAX_MEMORY_PER_CHILD_KB:-}" ]] && ARGS+=(--max-memory-per-child="${TDMM_MAX_MEMORY_PER_CHILD_KB}")
    exec celery -A app.tasks.celery_app worker "${ARGS[@]}"
    ;;
  *)
    echo "[entrypoint] unknown TDMM_ROLE=${TDMM_ROLE:-<unset>} (expected 'api' or 'worker')" >&2
    exit 1
    ;;
esac
