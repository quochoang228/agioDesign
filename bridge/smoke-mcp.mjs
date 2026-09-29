#!/usr/bin/env node
/**
 * End-to-end smoke test for the MCP relay against the real `claude` CLI, with
 * this script standing in for the Figma plugin: it holds /mcp/events open,
 * answers tool calls with canned data, and starts a /run-agent task. Use it to
 * re-check the version-sensitive claude flags after a CLI upgrade.
 *
 *   npm run bridge          # in one terminal
 *   npm run smoke:mcp       # in another (spends a few Haiku tokens)
 *
 * Reads BRIDGE_PORT (default 3939) and BRIDGE_TOKEN (default: the bridge's
 * saved token in ~/.agiodesign-bridge/token).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = process.env.BRIDGE_PORT || '3939';
const token =
  process.env.BRIDGE_TOKEN || fs.readFileSync(path.join(os.homedir(), '.agiodesign-bridge', 'token'), 'utf8').trim();
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-bridge-token': token, 'content-type': 'application/json' };
const session = `smoke${Date.now().toString(36)}`;
const calls = [];

const events = await fetch(`${base}/mcp/events?session=${session}`, { headers });
if (!events.ok) throw new Error(`/mcp/events ${events.status}: ${await events.text()}`);

// Fake plugin: answer every relayed tool call.
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of events.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.startsWith('data:')) continue;
      const { callId, name } = JSON.parse(frame.slice(5));
      calls.push(name);
      const result =
        name === 'get_selection'
          ? { count: 2, nodes: [{ id: '1:2', name: 'Frame A', type: 'FRAME' }, { id: '1:3', name: 'Frame B', type: 'FRAME' }] }
          : { ok: true };
      await fetch(`${base}/mcp/result`, { method: 'POST', headers, body: JSON.stringify({ session, callId, ok: true, result }) });
    }
  }
})().catch(() => {});

const run = await fetch(`${base}/run-agent`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    session,
    cli: 'claude',
    model: 'haiku',
    task: 'Call get_selection, then rename node 1:2 to "Hero" with rename_nodes. Then reply with one line: the number of selected nodes.',
  }),
});
let stream = '';
const dec = new TextDecoder();
for await (const c of run.body) stream += dec.decode(c, { stream: true });

const text = [...stream.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
const errors = text.filter((e) => e.error).map((e) => e.error);
console.log('tool calls :', calls.join(', ') || '(none)');
console.log('reply      :', text.map((e) => e.text || '').join('').trim());
const ok = !errors.length && calls.includes('get_selection') && calls.includes('rename_nodes');
if (errors.length) console.log('errors     :', errors.join(' | '));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
