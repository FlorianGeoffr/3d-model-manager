#!/usr/bin/env bash
# M1 acceptance gate (Task 9): builds and starts the full docker compose
# stack, waits for the api to become healthy, drives the complete
# upload/revision/diff/download/restart flow through the real HTTP API
# (backend/tests_e2e/test_m1_flow.py), then tears the stack down.
#
# Usage: scripts/e2e-m1.sh [--keep-volumes]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BASE_URL="${TDMM_E2E_BASE_URL:-http://localhost:8080}"
HEALTH_URL="${BASE_URL}/api/health"
HEALTH_TIMEOUT_S=120
KEEP_VOLUMES=0

for arg in "$@"; do
  case "$arg" in
    --keep-volumes) KEEP_VOLUMES=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: $0 [--keep-volumes]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "==> No .env found; copying .env.example (edit before real use)."
  cp .env.example .env
fi

# The e2e test needs a KNOWN admin password to log in with -- a randomly
# generated first-run password is only ever printed once to the api
# container's logs, which the test has no way to read back. Pin a fixed one
# into .env for this run if none is already set there.
if ! grep -qE '^TDMM_ADMIN_PASSWORD=.+' .env; then
  echo "==> No TDMM_ADMIN_PASSWORD set in .env; pinning one for this e2e run."
  grep -vE '^#?TDMM_ADMIN_PASSWORD=' .env > .env.tmp && mv .env.tmp .env
  echo "TDMM_ADMIN_PASSWORD=e2e-test-admin-password" >> .env
fi
TDMM_ADMIN_PASSWORD="$(grep -E '^TDMM_ADMIN_PASSWORD=' .env | tail -n1 | cut -d= -f2-)"
TDMM_ADMIN_USERNAME="$(grep -E '^TDMM_ADMIN_USERNAME=' .env | tail -n1 | cut -d= -f2-)"
export TDMM_ADMIN_PASSWORD
export TDMM_ADMIN_USERNAME="${TDMM_ADMIN_USERNAME:-admin}"

cleanup() {
  local status=$?
  echo "==> compose logs (api, tail 100) ----------------------------------"
  docker compose logs api --tail=100 || true
  echo "==> tearing down the stack..."
  if [[ "$KEEP_VOLUMES" == "1" ]]; then
    docker compose down
  else
    docker compose down --volumes
  fi
  exit "$status"
}
trap cleanup EXIT

echo "==> Building and starting the stack..."
docker compose up -d --build

echo "==> Waiting for ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT_S}s)..."
elapsed=0
until curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; do
  if (( elapsed >= HEALTH_TIMEOUT_S )); then
    echo "Timed out waiting for the api to become healthy." >&2
    docker compose ps
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
echo "==> api is healthy."

echo "==> Running the M1 e2e flow..."
TDMM_E2E_BASE_URL="${BASE_URL}" uv run --project backend pytest backend/tests_e2e -q -m e2e
