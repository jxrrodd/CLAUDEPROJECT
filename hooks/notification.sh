#!/usr/bin/env bash
# Notification hook — fired on Claude Code notifications / prompts
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOOKS_DIR/send-event.sh" "Notification"
