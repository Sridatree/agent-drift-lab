#!/usr/bin/env bash
set -euo pipefail

claude_settings=/home/node/.claude/settings.json
if [[ ! -f "$claude_settings" ]]; then
  mkdir -p "$(dirname "$claude_settings")"
  echo '{"tui":"default"}' > "$claude_settings"
fi
if [[ "$(jq -r '.tui // ""' "$claude_settings")" != default ]]; then
  jq '.tui = "default"' "$claude_settings" > "$claude_settings.tmp" \
    && mv "$claude_settings.tmp" "$claude_settings"
fi

relay_target="${DEVBOX_OTEL_COLLECTOR:-}"

# Claude Code sends to 127.0.0.1:4318; the relay forwards to the collector without the account's
# identity (otel-relay.js).
if [[ -n "$relay_target" ]]; then
  node /usr/local/lib/devbox/otel-relay.js "$relay_target" >/dev/null 2>&1 &
fi

exec "$@"
