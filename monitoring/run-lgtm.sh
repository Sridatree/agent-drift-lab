#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

container_runtime="${CONTAINER_RUNTIME:-}"
if [[ -z "$container_runtime" ]]; then
  if command -v docker >/dev/null 2>&1; then
    container_runtime="docker"
  elif command -v podman >/dev/null 2>&1; then
    container_runtime="podman"
  else
    echo "Neither docker nor podman is available in PATH" >&2
    exit 1
  fi
fi

if "$container_runtime" ps -a --format '{{.Names}}' | grep -qx otel-lgtm; then
  echo "otel-lgtm already exists; '$container_runtime rm -f otel-lgtm' first to restart it with these rules" >&2
  exit 1
fi

if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  "$container_runtime" run --rm -d --name otel-lgtm \
    -p 3000:3000 -p 4317:4317 -p 4318:4318 \
    -e "SLACK_WEBHOOK_URL=$SLACK_WEBHOOK_URL" \
    grafana/otel-lgtm >/dev/null
else
  "$container_runtime" run --rm -d --name otel-lgtm \
    -p 3000:3000 -p 4317:4317 -p 4318:4318 \
    grafana/otel-lgtm >/dev/null
fi

echo -n "waiting for Grafana"
until curl -fsS -o /dev/null http://localhost:3000/api/health 2>/dev/null; do
  echo -n .
  sleep 2
done
echo

"$here/reload-rules.sh"

if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "Slack routing on"
else
  echo "Slack routing off (SLACK_WEBHOOK_URL not set)"
fi

echo "Grafana: http://localhost:3000/alerting/list (admin/admin)"
