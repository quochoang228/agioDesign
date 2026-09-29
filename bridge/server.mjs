#!/usr/bin/env node
/**
 * HTML-to-Figma-Pro — local CLI bridge.
 *
 * The Figma plugin sandbox cannot spawn processes or touch the filesystem, so
 * this companion server does it instead. Two capabilities:
 *
 *  Phase 3 — /generate: shell out to a CLI (claude/codex/opencode) one-shot and
 *            stream stdout back as SSE (used by "CLI · local bridge" providers).
 *
 *  Phase 5 — MCP relay: run a CLI agent that drives the Figma canvas via tools.
 *            The CLI talks MCP (stdio) to bridge/mcp-server.mjs, whose tool calls
 *            are relayed here and pushed to the plugin over SSE; the plugin runs
 *            them in the sandbox and POSTs results back.
 *              plugin  GET  /mcp/events?session=…   (SSE: receives tool calls)
 *              plugin  POST /mcp/result             (returns a tool result)
 *              mcp     POST /mcp/call               (asks the plugin to run a tool)
 *              plugin  POST /run-agent              (SSE: streams the CLI's text)
 *
 * Zero dependencies — run with:  node bridge/server.mjs [port]
 *
 * Security: binds to 127.0.0.1 only, and every route except /health requires the
 * `x-bridge-token` header. The token is generated once and stored in
 * ~/.html-to-figma-bridge/token (override with BRIDGE_TOKEN); paste it into the
 * plugin's Settings. Without it, any web page open in a browser could make the
 * bridge run CLIs or fetch internal URLs on your behalf.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || process.argv[2] || 3939);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(__dirname, 'mcp-server.mjs');
const TOKEN = loadToken();

/** Figma plugin iframes run with an opaque ("null") origin; allow extras via env. */
const ALLOWED_ORIGINS = new Set(['null', ...(process.env.BRIDGE_ALLOW_ORIGINS || '').split(',').filter(Boolean)]);
/** Reject DNS-rebinding requests: the Host header must name this loopback server. */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  const dir = path.join(os.homedir(), '.html-to-figma-bridge');
  const file = path.join(dir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    /* first run — generate below */
  }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

function tokenOk(req) {
  const got = Buffer.from(String(req.headers['x-bridge-token'] || ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const TOOL_NAMES = [
  'get_selection',
  'get_page_summary',
  'get_design_system',
  'rename_nodes',
  'set_auto_layout',
  'align_nodes',
  'set_fill',
  'set_text',
  'generate_image',
  'web_fetch',
  'web_search',
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** One-shot CLI invocations for /generate (Phase 3). */
const CLIS = {
  claude: { bin: 'claude', args: (prompt, model) => ['--print', ...(useModel(model) ? ['--model', model] : []), prompt] },
  codex: { bin: 'codex', args: (prompt, model) => ['exec', ...(useModel(model) ? ['-m', model] : []), prompt] },
  opencode: { bin: 'opencode', args: (prompt, model) => ['run', ...(useModel(model) ? ['-m', model] : []), prompt] },
};

const useModel = (m) => m && m !== 'default';

/** session id → { events: ServerResponse|null, pending: Map<callId,{resolve,timer}>, seq } */
const sessions = new Map();
const getSession = (id) => {
  let s = sessions.get(id);
  if (!s) {
    s = { events: null, pending: new Map(), seq: 0 };
    sessions.set(id, s);
  }
  return s;
};

function cors(res) {
  const origin = res.req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-bridge-token');
}
function sseHead(res) {
  cors(res);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}
function json(res, obj, code = 200) {
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 8_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve(null);
      }
    });
  });

function onPath(bin) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
}
const clisStatus = () => ({ claude: onPath('claude'), codex: onPath('codex'), opencode: onPath('opencode') });

/** True for loopback, private, link-local, CGNAT, multicast and other non-public IPs. */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/** Throws unless `raw` is an http(s) URL whose host resolves only to public IPs. */
async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('refusing to fetch a private or local address');
  }
  return u;
}

/** fetch() that re-checks every redirect hop against the private-address guard. */
async function publicFetch(raw, maxHops = 5) {
  let url = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = await assertPublicUrl(url);
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) return r;
    url = new URL(loc, u).toString();
  }
  throw new Error('too many redirects');
}

/** Best-effort scrape of the DuckDuckGo HTML endpoint into {title,url,snippet}[]. */
function parseDuckDuckGo(html) {
  const out = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const strip = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const snippets = [];
  let s;
  while ((s = snipRe.exec(html))) snippets.push(strip(s[1]));
  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < 6) {
    let href = m[1];
    if (href.includes('duckduckgo.com/y.js') || href.includes('ad_domain')) continue; // skip ads
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep raw */
      }
    }
    out.push({ title: strip(m[2]), url: href, snippet: snippets[i] || '' });
    i++;
  }
  return out;
}

function buildPrompt(system, messages) {
  const convo = (messages || []).map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
  return `${system}\n\n--- Conversation so far ---\n${convo}\n\n--- End ---\nProduce the deliverable now, following the output rules above exactly.`;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) {
    json(res, { error: 'bad host' }, 421);
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  // ---- health (unauthenticated; only reveals CLI status to token holders) ----
  if (req.method === 'GET' && route === '/health') {
    const authorized = tokenOk(req);
    json(res, authorized ? { ok: true, authorized, clis: clisStatus() } : { ok: true, authorized });
    return;
  }

  if (!tokenOk(req)) {
    json(res, { error: 'missing or wrong bridge token — copy it from the bridge terminal into plugin Settings' }, 401);
    return;
  }

  // ---- Phase 3: one-shot generate ----
  if (req.method === 'POST' && route === '/generate') {
    const payload = await readBody(req);
    const spec = payload && CLIS[payload.cli];
    if (!spec) {
      json(res, { error: 'unknown cli' }, 400);
      return;
    }
    sseHead(res);
    if (!onPath(spec.bin)) {
      send(res, { error: `"${spec.bin}" was not found on PATH.` });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const prompt = buildPrompt(payload.system || '', payload.messages || []);
    runStreaming(res, spec.bin, spec.args(prompt, payload.model), req);
    return;
  }

  // ---- Phase 6: server-side web tools (no CORS limits) ----
  if (req.method === 'GET' && route === '/fetch') {
    const target = url.searchParams.get('url') || '';
    try {
      const r = await publicFetch(target);
      const text = (await r.text()).slice(0, 200000);
      cors(res);
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    } catch (e) {
      json(res, { error: String(e?.message || e) }, 502);
    }
    return;
  }

  if (req.method === 'GET' && route === '/search') {
    const q = url.searchParams.get('q') || '';
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
        headers: { 'user-agent': UA },
      });
      const html = await r.text();
      json(res, { results: parseDuckDuckGo(html) });
    } catch (e) {
      json(res, { error: String(e?.message || e) }, 502);
    }
    return;
  }

  // ---- Phase 5: MCP relay ----

  // Plugin opens this to receive tool-call requests for a session.
  if (req.method === 'GET' && route === '/mcp/events') {
    const id = url.searchParams.get('session') || '';
    const s = getSession(id);
    sseHead(res);
    s.events = res;
    res.write(': connected\n\n');
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => {
      clearInterval(hb);
      if (s.events === res) s.events = null;
    });
    return;
  }

  // Plugin returns a tool result.
  if (req.method === 'POST' && route === '/mcp/result') {
    const b = await readBody(req);
    const s = b && sessions.get(b.session);
    const pend = s && s.pending.get(b.callId);
    if (pend) {
      clearTimeout(pend.timer);
      s.pending.delete(b.callId);
      pend.resolve(b.ok ? { ok: true, result: b.result } : { ok: false, error: b.error });
    }
    json(res, { ok: true });
    return;
  }

  // mcp-server.mjs asks the plugin to run a tool (blocks until the result).
  if (req.method === 'POST' && route === '/mcp/call') {
    const b = await readBody(req);
    const s = b && sessions.get(b.session);
    if (!s || !s.events) {
      json(res, { ok: false, error: 'Figma plugin not connected for this session.' });
      return;
    }
    const callId = `c${s.seq++}`;
    const out = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        s.pending.delete(callId);
        resolve({ ok: false, error: 'tool timed out' });
      }, 60000);
      s.pending.set(callId, { resolve, timer });
      send(s.events, { callId, name: b.name, args: b.args });
    });
    json(res, out);
    return;
  }

  // Plugin starts a CLI agent run (streams the CLI's text output).
  if (req.method === 'POST' && route === '/run-agent') {
    const b = await readBody(req);
    sseHead(res);
    if (!b || b.cli !== 'claude') {
      send(res, { error: 'MCP relay currently supports the Claude CLI. Use text-protocol agent mode for others.' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (!onPath('claude')) {
      send(res, { error: '"claude" not found on PATH.' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(b.session || ''))) {
      send(res, { error: 'invalid session id' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const cfgPath = path.join(os.tmpdir(), `h2f-mcp-${b.session}.json`);
    const cfg = {
      mcpServers: {
        figma: {
          command: process.execPath, // node
          args: [MCP_SERVER],
          env: { BRIDGE_PORT: String(PORT), MCP_SESSION: String(b.session), BRIDGE_TOKEN: TOKEN },
        },
      },
    };
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
    } catch (e) {
      send(res, { error: `cannot write mcp config: ${e.message}` });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const allowed = TOOL_NAMES.map((n) => `mcp__figma__${n}`).join(',');
    const args = [
      '--print',
      '--mcp-config',
      cfgPath,
      '--strict-mcp-config',
      '--allowedTools',
      allowed,
      '--output-format',
      'text',
      ...(useModel(b.model) ? ['--model', b.model] : []),
      b.task || '',
    ];
    runStreaming(res, 'claude', args, req, () => {
      try {
        fs.unlinkSync(cfgPath);
      } catch {
        /* ignore */
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

/** Spawn a CLI, stream stdout to the SSE response, finish with [DONE]. */
function runStreaming(res, bin, args, req, onDone) {
  const child = spawn(bin, args, { env: process.env });
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => send(res, { text: chunk }));
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  child.on('error', (e) => {
    send(res, { error: `spawn failed: ${e.message}` });
    res.write('data: [DONE]\n\n');
    res.end();
    onDone && onDone();
  });
  child.on('close', (code) => {
    if (code !== 0) send(res, { error: `${bin} exited ${code}: ${stderr.slice(0, 600)}` });
    res.write('data: [DONE]\n\n');
    res.end();
    onDone && onDone();
  });
  req.on('close', () => child.kill());
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`html-to-figma bridge → http://localhost:${PORT}`);
  console.log('CLIs on PATH:', clisStatus());
  console.log(`Bridge token (paste into plugin ⚙ Settings): ${TOKEN}`);
});
