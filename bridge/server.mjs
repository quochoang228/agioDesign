#!/usr/bin/env node
/**
 * agioDesign — local CLI bridge.
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
 * Normally it's installed once as a login item (`install.mjs`) and then turned
 * on/off from the plugin via /control/enable|disable.
 *
 * Security: binds to 127.0.0.1 only, and every route except /health and /pair
 * requires the `x-bridge-token` header. The token is generated once and stored
 * in ~/.agiodesign-bridge/token (override with BRIDGE_TOKEN). The plugin gets
 * it via /pair, which only hands it out after the user clicks Allow in a native
 * OS dialog. Without it, any web page open in a browser could make the bridge
 * run CLIs or fetch internal URLs on your behalf.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.mjs';
import { UA, publicFetch, parseDuckDuckGo } from './net.mjs';
import { DEFAULT_PORT, DATA_DIR, TOKEN_FILE, STATE_FILE, PID_FILE, IS_BINARY } from './paths.mjs';

// Port: $PORT, or a numeric argument (`node server.mjs 4000`; `cli.mjs serve` passes "serve").
const PORT = Number(process.env.PORT || process.argv.slice(2).find((a) => /^\d+$/.test(a)) || DEFAULT_PORT);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(__dirname, 'mcp-server.mjs');
const TOKEN = loadToken();

/** Figma plugin iframes run with an opaque ("null") origin; allow extras via env. */
const ALLOWED_ORIGINS = new Set(['null', ...(process.env.BRIDGE_ALLOW_ORIGINS || '').split(',').filter(Boolean)]);
const warnedOrigins = new Set();
/** Reject DNS-rebinding requests: the Host header must name this loopback server. */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {
    /* first run — generate below */
  }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}

/** On/off switch toggled from the plugin; persisted so it survives restarts. */
let enabled = (() => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).enabled !== false;
  } catch {
    return true;
  }
})();

function setEnabled(on) {
  enabled = on;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: on }));
  } catch {
    /* non-fatal: state just won't persist */
  }
  if (!on) {
    // Turning off stops everything in flight, not just new requests.
    for (const child of children) child.kill();
    for (const s of sessions.values()) s.events?.end();
    sessions.clear();
  }
  console.log(`Bridge turned ${on ? 'on' : 'off'}.`);
}

function tokenOk(req) {
  const got = Buffer.from(String(req.headers['x-bridge-token'] || ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * One-shot CLI invocations for /generate (Phase 3). The prompt is written to the
 * child's stdin, not argv: whole conversations can exceed ARG_MAX, and argv is
 * visible to every local user via `ps`.
 */
const CLIS = {
  claude: { bin: 'claude', args: (model) => ['--print', ...(useModel(model) ? ['--model', model] : [])] },
  codex: { bin: 'codex', args: (model) => ['exec', ...(useModel(model) ? ['-m', model] : []), '-'] },
  opencode: { bin: 'opencode', args: (model) => ['run', ...(useModel(model) ? ['-m', model] : [])] },
};

const useModel = (m) => m && m !== 'default';
/** Model ids reach argv (and a shell on Windows), so only allow plain id characters. */
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;

/** Running CLI child processes, so turning the bridge off can stop them. */
const children = new Set();

/**
 * Spawn an installed CLI. On Windows, npm-installed CLIs are `.cmd` shims that
 * Node can only start through a shell, so each arg is quoted; callers only pass
 * fixed flags, validated model ids and temp paths (prompts go via stdin).
 */
function spawnCli(bin, args) {
  if (process.platform !== 'win32') return spawn(bin, args, { env: process.env });
  const quoted = args.map((a) => `"${String(a).replace(/"/g, '""')}"`);
  return spawn(bin, quoted, { env: process.env, shell: true, windowsHide: true });
}

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
  } else if (origin && !warnedOrigins.has(origin)) {
    warnedOrigins.add(origin);
    console.warn(`Blocked CORS origin ${origin} (allow it with BRIDGE_ALLOW_ORIGINS=${origin} if it is yours)`);
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
    // pid lets the installer stop whichever bridge holds the port.
    const base = { ok: true, authorized, enabled, pid: process.pid };
    json(res, authorized ? { ...base, clis: clisStatus() } : base);
    return;
  }

  // ---- pairing: hand the token to the plugin once the user clicks Allow ----
  if (req.method === 'POST' && route === '/pair') {
    json(res, ...(await pair()));
    return;
  }

  if (!tokenOk(req)) {
    json(res, { error: 'missing or wrong bridge token — click Connect in the plugin to pair again' }, 401);
    return;
  }

  // ---- on/off switch ----
  if (req.method === 'POST' && (route === '/control/enable' || route === '/control/disable')) {
    setEnabled(route === '/control/enable');
    json(res, { ok: true, enabled });
    return;
  }

  if (!enabled) {
    json(res, { error: 'The bridge is turned off — turn it on in the plugin.' }, 503);
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
    if (useModel(payload.model) && !MODEL_RE.test(payload.model)) {
      json(res, { error: 'invalid model id' }, 400);
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
    runStreaming(res, spec.bin, spec.args(payload.model), prompt, req);
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

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(b.session || '')) || (useModel(b.model) && !MODEL_RE.test(b.model))) {
      send(res, { error: 'invalid session id or model' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const cfgPath = path.join(os.tmpdir(), `h2f-mcp-${b.session}.json`);
    const cfg = {
      mcpServers: {
        figma: {
          // node + script, or the packaged executable's `mcp` sub-command.
          command: process.execPath,
          args: IS_BINARY ? ['mcp'] : [MCP_SERVER],
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
    ];
    runStreaming(res, 'claude', args, String(b.task || ''), req, () => {
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

/** Spawn a CLI, feed `input` on stdin, stream stdout to the SSE response, finish with [DONE]. */
function runStreaming(res, bin, args, input, req, onDone) {
  const child = spawnCli(bin, args);
  children.add(child);
  child.on('close', () => children.delete(child));
  child.stdin.on('error', () => {}); // CLI may exit before reading all input
  child.stdin.end(input);
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

// ---- pairing dialog ----

let pairing = null; // in-flight pair() promise — one dialog at a time
let pairCooldownUntil = 0;

/** Show a native Allow/Deny dialog; resolve to [body, status] for the /pair response. */
function pair() {
  if (pairing) return pairing;
  if (Date.now() < pairCooldownUntil) return Promise.resolve([{ error: 'Pairing was just denied — try again in a few seconds.' }, 429]);
  pairing = askUser(
    'A Figma plugin (agioDesign) wants to connect to the local bridge. ' +
      'It will be able to run your installed AI CLIs. Allow?',
  )
    .then((answer) => {
      if (answer === 'allow') return [{ ok: true, token: TOKEN }, 200];
      pairCooldownUntil = Date.now() + 10_000;
      if (answer === 'deny') return [{ error: 'Connection was denied.' }, 403];
      return [{ error: `Couldn't show a confirmation dialog on this system. Paste the token from ${TOKEN_FILE} into Settings instead.` }, 501];
    })
    .finally(() => {
      pairing = null;
    });
  return pairing;
}

/** Resolve 'allow' | 'deny' | 'unsupported' from a native OS dialog. */
function askUser(message) {
  const title = 'agioDesign Bridge';
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    cmd = 'osascript';
    args = [
      '-e',
      `display dialog "${esc(message)}" with title "${esc(title)}" buttons {"Deny", "Allow"} ` +
        'default button "Allow" cancel button "Deny" with icon caution giving up after 120',
      '-e',
      'if gave up of result then error number -128',
    ];
  } else if (process.platform === 'win32') {
    const esc = (s) => s.replace(/'/g, "''");
    cmd = 'powershell.exe';
    args = [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; ' +
        `$r = [System.Windows.Forms.MessageBox]::Show($f, '${esc(message)}', '${esc(title)}', 'YesNo', 'Warning'); ` +
        "if ($r -eq 'Yes') { exit 0 } else { exit 1 }",
    ];
  } else if (onPath('zenity')) {
    cmd = 'zenity';
    args = ['--question', `--title=${title}`, `--text=${message}`, '--ok-label=Allow', '--cancel-label=Deny', '--timeout=120'];
  } else if (onPath('kdialog')) {
    cmd = 'kdialog';
    args = ['--title', title, '--yesno', message];
  } else {
    return Promise.resolve('unsupported');
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve('unsupported'));
    child.on('close', (code) => resolve(code === 0 ? 'allow' : 'deny'));
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Another bridge (e.g. the installed login item) already owns the port.
    // Exit 0 so a service manager doesn't restart-loop us.
    console.log(`Port ${PORT} is in use — a bridge is probably already running. Nothing to do.`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  // The installer stops the login-item bridge through this file; ad-hoc
  // instances on other ports (tests, `npm run bridge 4000`) leave it alone.
  if (PORT === DEFAULT_PORT) {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid));
    } catch {
      /* non-fatal */
    }
  }
  console.log(`agioDesign bridge → http://localhost:${PORT} (${enabled ? 'on' : 'off'})`);
  console.log('CLIs on PATH:', clisStatus());
  console.log(`Token (Connect in the plugin pairs automatically): ${TOKEN}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of children) child.kill();
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
