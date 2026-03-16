#!/usr/bin/env bash
# send-event.sh <hookType>
# Reads JSON from stdin (Claude Code hook payload), enriches it, and POSTs to monitor server.
# Usage: echo '{"tool":"Bash","input":{"command":"ls"}}' | send-event.sh PreToolUse

set -euo pipefail

MONITOR_URL="${CLAUDE_MONITOR_URL:-http://localhost:3005/event}"
HOOK_TYPE="${1:-Unknown}"

# Read stdin (the hook payload from Claude Code)
INPUT="$(cat)"

# Merge hookType into the payload and add sessionId from env if available
SESSION_ID="${CLAUDE_SESSION_ID:-}"
AGENT_ID="${CLAUDE_AGENT_ID:-}"

export INPUT HOOK_TYPE SESSION_ID AGENT_ID

PAYLOAD=$(node -e "
  const d = JSON.parse(process.env.INPUT || '{}');
  d.hookType = process.env.HOOK_TYPE;
  if (process.env.SESSION_ID) d.sessionId = process.env.SESSION_ID;
  if (process.env.AGENT_ID)   d.agentId   = process.env.AGENT_ID;

  // Pull command to top-level for easy display
  if (d.tool === 'Bash' && d.input && d.input.command) d.command = d.input.command;
  if (d.tool === 'Bash' && d.output) {
    d.exitCode = typeof d.output.exitCode !== 'undefined' ? d.output.exitCode : null;
  }

  console.log(JSON.stringify(d));
" 2>/dev/null) || PAYLOAD="{\"hookType\":\"$HOOK_TYPE\",\"raw\":true}"

# Fire-and-forget: don't block Claude Code
curl -s -o /dev/null --max-time 2 \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  "$MONITOR_URL" &

exit 0
