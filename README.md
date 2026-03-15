# Claude Code Activity Monitor

A real-time web dashboard that monitors all Claude Code activity — just like NetworkChuck's setup.

## How It Works

```
n8n  ──►  claude --dangerously-skip-permissions --session-id <uuid>
                      │
                      ▼  (Claude Code hooks fire on every event)
              hooks/pre-tool-use.sh
              hooks/post-tool-use.sh
              hooks/stop.sh
                      │
                      ▼  (HTTP POST to local server)
              monitor-server.js  (port 3005)
                      │
                      ▼  (WebSocket broadcast)
              Browser dashboard  ◄── http://localhost:3005
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the monitor server
```bash
npm start
# or with a custom port:
node monitor-server.js 3005
```

### 3. Open the dashboard
Navigate to **http://localhost:3005** in your browser.

### 4. Hooks are auto-registered
`~/.claude/settings.json` has been updated with `PreToolUse`, `PostToolUse`, `Notification`, and `Stop` hooks pointing to `hooks/`.

Any Claude Code session (including ones triggered from n8n) will now stream events to the dashboard.

## n8n Integration

In n8n, use an **Execute Command** node with:

```
claude --dangerously-skip-permissions --session-id {{ $json.uuid }} -p "{{ $json.prompt }}"
```

Set `CLAUDE_MONITOR_URL=http://localhost:3005/event` in the environment if n8n runs on a different host.

## Dashboard Features

| Feature | Description |
|---------|-------------|
| **Event Feed** | Live stream of all Claude Code events |
| **Filter tabs** | Filter by TOOLS / AGENTS / PROMPTS / SESSIONS |
| **Agents Graph** | Per-session/agent breakdown |
| **Stats bar** | Total events, tools used, agents, sessions |
| **Reset** | Clear all stats and history |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MONITOR_URL` | `http://localhost:3005/event` | Hook POST target |
| `CLAUDE_SESSION_ID` | (auto from Claude Code) | Session identifier |
| `CLAUDE_AGENT_ID` | (auto from Claude Code) | Agent identifier |
