#!/usr/bin/env bash
# PreToolUse hook — called by Claude Code before every tool execution
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOOKS_DIR/send-event.sh" "PreToolUse"
