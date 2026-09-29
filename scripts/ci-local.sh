#!/usr/bin/env bash
# Run the CI pipeline locally, mirroring .github/workflows/ci.yml:
# boot the stack, wait for readiness, run the integration tests, tear down.
set -euo pipefail
cd "$(dirname "$0")/.."

# Base stack + test overrides (see docker-compose.test.yml).
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.test.yml)

teardown() { echo "==> docker compose down -v"; "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "==> docker compose up -d --build (with test overrides)"
"${COMPOSE[@]}" up -d --build

echo "==> waiting for Bouncer /health"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/health >/dev/null; then
    echo "    ready after ~$((i * 2))s"; break
  fi
  if [ "$i" = 60 ]; then echo "    not ready in time"; "${COMPOSE[@]}" logs bouncer; exit 1; fi
  sleep 2
done

echo "==> npm test"
npm test
