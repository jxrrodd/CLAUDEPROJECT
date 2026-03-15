#!/usr/bin/env bash
# PostToolUse hook — called by Claude Code after every tool execution
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOOKS_DIR/send-event.sh" "PostToolUse"
