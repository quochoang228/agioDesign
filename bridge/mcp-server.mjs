#!/usr/bin/env node
/**
 * stdio MCP server exposing the plugin's Figma tools to a CLI agent (Phase 5).
 *
 * The CLI (e.g. `claude`) launches this over stdio and discovers the tools via
 * MCP. Since only the Figma plugin can touch the document, `tools/call` is
 * relayed over HTTP to the bridge (BRIDGE_PORT), which forwards it to the plugin
 * (SSE) and returns the result. Spawned by bridge/server.mjs with BRIDGE_PORT
 * MCP_SESSION and BRIDGE_TOKEN in the environment.
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0. Logs go to stderr only.
 */
import readline from 'node:readline';
import { TOOLS } from './tools.mjs';

const BRIDGE_PORT = process.env.BRIDGE_PORT || '3939';
const SESSION = process.env.MCP_SESSION || '';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const PROTOCOL = '2025-06-18';


const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const ok = (id, res) => write({ jsonrpc: '2.0', id, result: res });
const err = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

/** Relay a tool call to the bridge → plugin → Figma, and return {ok,result?,error?}. */
async function relay(name, args) {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
      body: JSON.stringify({ session: SESSION, name, args: args || {} }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: `bridge unreachable: ${e.message}` };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'html-to-figma-figma', version: '1.0.0' },
      });
      break;
    case 'ping':
      ok(id, {});
      break;
    case 'tools/list':
      ok(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const out = await relay(params && params.name, params && params.arguments);
      const text = JSON.stringify(out.ok ? out.result ?? { ok: true } : { error: out.error });
      ok(id, { content: [{ type: 'text', text }], isError: !out.ok });
      break;
    }
    default:
      // Notifications (no id) are ignored; unknown requests get an error.
      if (id !== undefined && method && !method.startsWith('notifications/')) {
        err(id, -32601, `Method not found: ${method}`);
      }
  }
});
