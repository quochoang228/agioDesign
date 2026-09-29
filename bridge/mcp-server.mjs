#!/usr/bin/env node
/**
 * stdio MCP server exposing the plugin's Figma tools to a CLI agent (Phase 5).
 *
 * The CLI (e.g. `claude`) launches this over stdio and discovers the tools via
 * MCP. Since only the Figma plugin can touch the document, `tools/call` is
 * relayed over HTTP to the bridge (BRIDGE_PORT), which forwards it to the plugin
 * (SSE) and returns the result. Spawned by bridge/server.mjs with BRIDGE_PORT
 * and MCP_SESSION in the environment.
 *
 * MCP stdio transport = newline-delimited JSON-RPC 2.0. Logs go to stderr only.
 */
import readline from 'node:readline';

const BRIDGE_PORT = process.env.BRIDGE_PORT || '3939';
const SESSION = process.env.MCP_SESSION || '';
const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'get_selection', description: 'List currently selected nodes (id, name, type, x, y, w, h).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_page_summary', description: 'List top-level nodes on the current page.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_design_system', description: 'List local paint styles, text styles, and components (id + name).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'rename_nodes',
    description: 'Rename one or more nodes by id.',
    inputSchema: {
      type: 'object',
      properties: { renames: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } } },
      required: ['renames'],
    },
  },
  {
    name: 'set_auto_layout',
    description: 'Apply auto layout to a frame/component.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        direction: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL'] },
        itemSpacing: { type: 'number' },
        padding: { description: 'number, or {top,right,bottom,left}' },
        primaryAxisAlign: { type: 'string' },
        counterAxisAlign: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'align_nodes',
    description: 'Align nodes that share a parent. Omit ids to use the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        axis: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center-x', 'center-y'] },
        distribute: { type: 'string', enum: ['horizontal', 'vertical'] },
      },
      required: ['axis'],
    },
  },
  {
    name: 'set_fill',
    description: 'Set a solid fill colour on nodes. Omit ids to use the selection.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, color: { type: 'string' }, opacity: { type: 'number' } },
      required: ['color'],
    },
  },
  {
    name: 'set_text',
    description: 'Replace the characters of a TEXT node.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, characters: { type: 'string' } }, required: ['id', 'characters'] },
  },
  {
    name: 'generate_image',
    description: 'Generate an image from a prompt and place it on the canvas, or fill a node when targetId is given.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, targetId: { type: 'string' } },
      required: ['prompt'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch the readable text of a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'web_search',
    description: 'Search the web and return top results.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const ok = (id, res) => write({ jsonrpc: '2.0', id, result: res });
const err = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

/** Relay a tool call to the bridge → plugin → Figma, and return {ok,result?,error?}. */
async function relay(name, args) {
  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
