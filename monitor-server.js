#!/usr/bin/env node
/**
 * Claude Code Activity Monitor Server
 * Receives events from Claude Code hooks and broadcasts to dashboard via WebSocket
 * Usage: node monitor-server.js [port]   (default: 3005)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.argv[2] || 3005;

// In-memory state
const state = {
  events: [],
  stats: { totalEvents: 0, toolsUsed: new Set(), agents: new Set(), sessions: new Set() },
  clients: new Set(),
};

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // POST /event  — called by hook scripts
  if (req.method === 'POST' && url.pathname === '/event') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        handleEvent(event);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
    return;
  }

  // POST /reset  — reset stats
  if (req.method === 'POST' && url.pathname === '/reset') {
    state.events = [];
    state.stats = { totalEvents: 0, toolsUsed: new Set(), agents: new Set(), sessions: new Set() };
    broadcast({ type: 'reset' });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /state  — full state snapshot for new clients
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(serializeState()));
    return;
  }

  // Serve static dashboard files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  state.clients.add(ws);
  // Send full state on connect
  ws.send(JSON.stringify({ type: 'snapshot', data: serializeState() }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'reset') {
        state.events = [];
        state.stats = { totalEvents: 0, toolsUsed: new Set(), agents: new Set(), sessions: new Set() };
        broadcast({ type: 'reset' });
      }
    } catch {}
  });

  ws.on('close', () => state.clients.delete(ws));
  ws.on('error', () => state.clients.delete(ws));
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function handleEvent(raw) {
  const event = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    timestamp: new Date().toISOString(),
    ...raw,
  };

  state.events.unshift(event); // newest first
  if (state.events.length > 500) state.events.pop();

  state.stats.totalEvents++;
  if (event.tool) state.stats.toolsUsed.add(event.tool);
  if (event.agentId) state.stats.agents.add(event.agentId);
  if (event.sessionId) state.stats.sessions.add(event.sessionId);

  broadcast({ type: 'event', data: event, stats: serializeStats() });
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of state.clients) {
    try { ws.send(payload); } catch {}
  }
}

function serializeStats() {
  return {
    totalEvents: state.stats.totalEvents,
    toolsUsed: state.stats.toolsUsed.size,
    agents: state.stats.agents.size,
    sessions: state.stats.sessions.size,
  };
}

function serializeState() {
  return { events: state.events, stats: serializeStats() };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code Monitor running at http://0.0.0.0:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Hook endpoint: http://localhost:${PORT}/event`);
});
