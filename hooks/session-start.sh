#!/usr/bin/env bash
# SessionStart hook — fired when a new Claude Code session begins
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOOKS_DIR/send-event.sh" "SessionStart"
