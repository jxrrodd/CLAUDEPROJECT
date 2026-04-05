#!/usr/bin/env node
/**
 * Claude Code Activity Monitor Server
 * Receives events from Claude Code hooks and broadcasts to dashboard via WebSocket
 * Usage: node monitor-server.js [port]   (default: 3005)
 */

const http = require('http');
const https = require('https');
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

// Gold price cache (15-minute TTL)
const goldCache = { data: null, fetchedAt: null, ttlMs: 15 * 60 * 1000, inflight: false };

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

  // GET /api/gold-prices  — Singapore 916 gold price comparison
  if (req.method === 'GET' && url.pathname === '/api/gold-prices') {
    const now = Date.now();
    const cacheValid = goldCache.data &&
      goldCache.fetchedAt &&
      (now - goldCache.fetchedAt.getTime()) < goldCache.ttlMs;

    if (cacheValid) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(goldCache.data));
      return;
    }

    if (goldCache.inflight) {
      // Serve stale while inflight, or wait briefly
      if (goldCache.data) {
        const stale = { ...goldCache.data, stale: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stale));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Fetching prices, please retry in a moment', retailers: [] }));
      }
      return;
    }

    goldCache.inflight = true;
    fetchAllGoldPrices().then(result => {
      goldCache.data = result;
      goldCache.fetchedAt = new Date();
      goldCache.inflight = false;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      goldCache.inflight = false;
      console.error('[gold] fetchAllGoldPrices failed:', err);
      if (goldCache.data) {
        const stale = { ...goldCache.data, stale: true };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stale));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch gold prices', retailers: [] }));
      }
    });
    return;
  }

  // GET /gold  — alias to gold.html
  if (req.method === 'GET' && url.pathname === '/gold') {
    url.pathname = '/gold.html';
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

// ── Monitor helpers ────────────────────────────────────────────────────────────
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

// ── Gold price scraper ─────────────────────────────────────────────────────────

function httpsGet(urlStr, timeoutMs = 8000, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth >= 5) return reject(new Error('Too many redirects'));
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
        'Accept-Language': 'en-SG,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      timeout: timeoutMs,
    };

    const req = https.get(options, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        return resolve(httpsGet(redirectUrl, timeoutMs, depth + 1));
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${urlStr}`)); });
    req.on('error', reject);
  });
}

function validPrice(p) {
  return typeof p === 'number' && isFinite(p) && p > 50 && p < 600;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[,$\s]/g, ''));
  return validPrice(n) ? n : null;
}

function errorEntry(name, url, msg) {
  return { name, url, status: 'error', buy_price: null, sell_price: null, price_per_gram_sgd: null, note: `Fetch error: ${msg}` };
}

function browserEntry(name, url, note = 'JS-rendered site; prices not in static HTML') {
  return { name, url, status: 'requires_browser', buy_price: null, sell_price: null, price_per_gram_sgd: null, note };
}

// Try to extract a 916 price from raw HTML using multiple regex patterns
function extract916Price(html) {
  const patterns = [
    // Table: 916 ... number
    /916[^<]{0,200}?([\d]{2,3}[.,]\d{2})/i,
    // JSON blob: "916": "123.45" or "916":"123.45"
    /"916"\s*:\s*"?\$?([\d]{2,3}[.,]\d{2})"?/,
    // SGD X.XX /g or per gram
    /SGD\s+([\d]{2,3}[.,]\d{2})\s*(?:\/\s*g|per\s*g)/i,
    // $X.XX per gram near 916
    /\$\s*([\d]{2,3}[.,]\d{2})\s*(?:per\s*gram|\/g)/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const price = parsePrice(m[1]);
      if (price) return price;
    }
  }
  return null;
}

// Try to extract from Next.js __NEXT_DATA__ blob
function extractFromNextData(html, label = '916') {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    const str = JSON.stringify(data);
    // Search for label near a price number
    const re = new RegExp('"' + label + '"[\\s\\S]{0,400}?([\\d]{2,3}[.,]\\d{2})');
    const hit = str.match(re);
    if (hit) return parsePrice(hit[1]);
  } catch {}
  return null;
}

async function fetchSpotPrice() {
  try {
    const body = await httpsGet('https://data-asg.goldprice.org/dbXRates/SGD', 6000);
    const json = JSON.parse(body);
    const item = json.items && json.items.find(i => i.curr === 'SGD');
    if (!item || !item.xauPrice) throw new Error('No SGD item');
    const spotPerOz = item.xauPrice;
    const spotPerGram24k = spotPerOz / 31.1035;
    const spotPerGram916 = spotPerGram24k * 0.916;
    return {
      source: 'goldprice.org',
      spot_per_oz_sgd: Math.round(spotPerOz * 100) / 100,
      spot_per_gram_24k_sgd: Math.round(spotPerGram24k * 100) / 100,
      spot_per_gram_916_sgd: Math.round(spotPerGram916 * 100) / 100,
      fetched_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[gold] spot price fetch failed:', e.message);
    return null;
  }
}

async function scrapeSKJewellery() {
  const url = 'https://www.skjewellery.com/gold-price/';
  try {
    const html = await httpsGet(url);
    const price = extractFromNextData(html, '916') || extract916Price(html);
    if (price) return { name: 'SK Jewellery', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('SK Jewellery', url);
  } catch (e) { return errorEntry('SK Jewellery', url, e.message); }
}

async function scrapeJoyalukkas() {
  const url = 'https://www.joyalukkas.com/sg/goldrate';
  try {
    const html = await httpsGet(url);
    // Joyalukkas often server-renders a table
    const tableMatch = html.match(/22\s*[Kk][^<]{0,100}?([\d]{2,3}[.,]\d{2})/);
    let price = tableMatch ? parsePrice(tableMatch[1]) : null;
    if (!price) price = extract916Price(html);
    if (!price) price = extractFromNextData(html, '916');
    if (price) return { name: 'Joyalukkas', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Joyalukkas', url);
  } catch (e) { return errorEntry('Joyalukkas', url, e.message); }
}

async function scrapeMaxiCash() {
  const url = 'https://www.maxi-cash.com/gold-price/';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html) || extractFromNextData(html, '916');
    if (price) return { name: 'Maxi-Cash', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: 'Pawnshop rate' };
    return browserEntry('Maxi-Cash', url, 'JS-rendered; visit site for pawn/buy rates');
  } catch (e) { return errorEntry('Maxi-Cash', url, e.message); }
}

async function scrapeMingSeng() {
  const url = 'https://www.mingseng.com.sg/gold-price/';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html);
    if (price) return { name: 'Ming Seng Goldsmith', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Ming Seng Goldsmith', url);
  } catch (e) { return errorEntry('Ming Seng Goldsmith', url, e.message); }
}

async function scrapeOrientGoldsmiths() {
  const url = 'https://orientjewellers.com.sg/gold-price/';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html);
    if (price) return { name: 'Orient Goldsmiths', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Orient Goldsmiths', url);
  } catch (e) { return errorEntry('Orient Goldsmiths', url, e.message); }
}

async function scrapeStarlightJewellery() {
  const url = 'https://www.starlightjewellery.com.sg/pages/gold-prices';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html);
    if (price) return { name: 'Starlight Jewellery', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: 'Shopify page' };
    return browserEntry('Starlight Jewellery', url);
  } catch (e) { return errorEntry('Starlight Jewellery', url, e.message); }
}

async function scrapeGoldTraderSG() {
  const url = 'https://www.goldtrader.sg/gold-pricing/';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html);
    if (price) return { name: 'Gold Trader SG', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Gold Trader SG', url, 'JS-rendered; primarily bullion dealer');
  } catch (e) { return errorEntry('Gold Trader SG', url, e.message); }
}

async function scrapeChowSangSang() {
  const url = 'https://www.chowsangsang.com/en/gold-price-sgd';
  try {
    const html = await httpsGet(url);
    const price = extractFromNextData(html, '916') || extract916Price(html);
    if (price) return { name: 'Chow Sang Sang', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Chow Sang Sang', url);
  } catch (e) { return errorEntry('Chow Sang Sang', url, e.message); }
}

async function scrapeBullionStar() {
  const url = 'https://www.bullionstar.com/gold-price/';
  try {
    const html = await httpsGet(url);
    const price = extractFromNextData(html, '916') || extract916Price(html);
    if (price) return { name: 'BullionStar', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: 'Bullion dealer' };
    return browserEntry('BullionStar', url, 'JS-rendered; primarily bullion bars/coins');
  } catch (e) { return errorEntry('BullionStar', url, e.message); }
}

async function scrapeLeeHwa() {
  const url = 'https://www.leehwa.com/gold-price';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html) || extractFromNextData(html, '916');
    if (price) return { name: 'Lee Hwa Jewellery', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Lee Hwa Jewellery', url);
  } catch (e) { return errorEntry('Lee Hwa Jewellery', 'https://shop.leehwajewellery.com/', e.message); }
}

async function scrapeArthesdam() {
  const url = 'https://www.arthesdam.com.sg/';
  try {
    const html = await httpsGet(url);
    const price = extract916Price(html);
    if (price) return { name: 'Arthesdam Jewellery', url, status: 'ok', buy_price: null, sell_price: price, price_per_gram_sgd: price, note: '' };
    return browserEntry('Arthesdam Jewellery', url, 'Serangoon Road goldsmith; check site for daily rate');
  } catch (e) { return errorEntry('Arthesdam Jewellery', url, e.message); }
}

async function fetchAllGoldPrices() {
  const startTime = Date.now();
  console.log('[gold] Fetching all Singapore 916 gold prices...');

  const [spotResult, ...retailerResults] = await Promise.allSettled([
    fetchSpotPrice(),
    scrapeSKJewellery(),
    scrapeJoyalukkas(),
    scrapeMaxiCash(),
    scrapeMingSeng(),
    scrapeOrientGoldsmiths(),
    scrapeStarlightJewellery(),
    scrapeGoldTraderSG(),
    scrapeChowSangSang(),
    scrapeBullionStar(),
    scrapeLeeHwa(),
    scrapeArthesdam(),
  ]);

  const spot = spotResult.status === 'fulfilled' ? spotResult.value : null;

  const retailers = retailerResults.map(r => {
    if (r.status === 'fulfilled') return r.value;
    return { name: 'Unknown', url: '', status: 'error', buy_price: null, sell_price: null, price_per_gram_sgd: null, note: r.reason ? r.reason.message : 'Unknown error' };
  });

  // Add spot as a reference entry at the top
  if (spot) {
    retailers.unshift({
      name: 'Spot Price (Goldprice.org)',
      url: 'https://goldprice.org/gold-price-singapore.html',
      status: 'ok',
      buy_price: spot.spot_per_gram_916_sgd,
      sell_price: spot.spot_per_gram_916_sgd,
      price_per_gram_sgd: spot.spot_per_gram_916_sgd,
      note: 'International spot — no retail markup',
    });
  }

  const duration = Date.now() - startTime;
  const liveCount = retailers.filter(r => r.status === 'ok').length;
  console.log(`[gold] Done in ${duration}ms — ${liveCount}/${retailers.length} retailers live`);

  return {
    fetched_at: new Date().toISOString(),
    fetch_duration_ms: duration,
    spot,
    retailers,
  };
}

// ── Start server ───────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code Monitor running at http://0.0.0.0:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Gold prices: http://localhost:${PORT}/gold`);
  console.log(`Hook endpoint: http://localhost:${PORT}/event`);
});
