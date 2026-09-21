#!/usr/bin/env bash
# Run the CI pipeline locally, mirroring .github/workflows/ci.yml:
# boot the stack, wait for readiness, run the integration tests, tear down.
set -euo pipefail
cd "$(dirname "$0")/.."

teardown() { echo "==> docker compose down -v"; docker compose down -v >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> waiting for Bouncer /health"
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/health >/dev/null; then
    echo "    ready after ~$((i * 2))s"; break
  fi
  if [ "$i" = 60 ]; then echo "    not ready in time"; docker compose logs bouncer; exit 1; fi
  sleep 2
done

echo "==> npm test"
npm test
