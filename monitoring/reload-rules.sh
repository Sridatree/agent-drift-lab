#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest=/otel-lgtm/grafana/conf/provisioning/alerting

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

"$container_runtime" cp "$here/grafana/alerting/claude-code-rules.yaml" "otel-lgtm:$dest/claude-code-rules.yaml"

if [[ -f "$here/grafana/alerting/slack.yaml" ]]; then
  if "$container_runtime" exec otel-lgtm sh -c '[ -n "${SLACK_WEBHOOK_URL:-}" ]'; then
    "$container_runtime" cp "$here/grafana/alerting/slack.yaml" "otel-lgtm:$dest/slack.yaml"
  fi
fi

curl -fsS -u admin:admin -X POST http://localhost:3000/api/admin/provisioning/alerting/reload >/dev/null

titles="$(curl -fsS -u admin:admin http://localhost:3000/api/v1/provisioning/alert-rules | jq -r '[.[].title] | join(", ")')"
echo "rules reloaded: $titles"
