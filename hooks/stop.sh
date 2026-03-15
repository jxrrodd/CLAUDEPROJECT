#!/usr/bin/env bash
# Stop hook — fired when Claude Code session ends / stops
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOOKS_DIR/send-event.sh" "SessionEnd"
