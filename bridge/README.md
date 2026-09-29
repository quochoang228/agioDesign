# Local CLI bridge

The Figma plugin sandbox can't spawn processes or read the filesystem, so it
can't run your installed AI CLIs directly. This tiny companion server does it on
its behalf: the plugin's **AI Agent** tab POSTs to `http://localhost:3939`, and
the bridge shells out to `claude` / `codex` / `opencode` and streams the output
back. Your existing CLI auth is reused — **no API key needed in the plugin**.

## Run it

```bash
node bridge/server.mjs        # default port 3939
node bridge/server.mjs 4000   # custom port
```

Launch it from a terminal where the CLI you want is on your `PATH`. On startup
it prints which CLIs it found and its auth token:

```
html-to-figma bridge → http://localhost:3939
CLIs on PATH: { claude: true, codex: false, opencode: true }
Bridge token (paste into plugin ⚙ Settings): 3q2…
```

Then in the plugin: **AI Agent → ⚙ Settings**, pick a CLI provider (e.g.
*Claude CLI · local bridge*), confirm the Bridge URL matches, paste the token
into *Bridge token*, and chat. The token is stable across restarts (stored in
`~/.html-to-figma-bridge/token`; delete that file to rotate it, or set
`BRIDGE_TOKEN`).

## Endpoints

Every route except `/health` requires the `x-bridge-token` header (401 otherwise).

**Phase 3 — one-shot generate**
- `GET /health` → `{ ok, authorized }`, plus `clis: { claude, codex, opencode }`
  when the token is valid.
- `POST /generate` → body `{ cli, model, system, messages }`, streams SSE
  (`data: {"text":"…"}` chunks, then `data: [DONE]`; errors as `{"error":"…"}`).

**Phase 6 — server-side web tools** (no CORS limits)
- `GET /fetch?url=…` → returns the page's raw text (used by the `web_fetch` tool
  as a fallback when a direct browser fetch is blocked by CORS). Only public
  http(s) hosts; private, loopback and link-local addresses are refused, and
  each redirect hop is re-checked.
- `GET /search?q=…` → `{ results: [{title,url,snippet}] }` via a best-effort
  DuckDuckGo HTML scrape (keyless; may be rate-limited or change shape).

**Phase 5 — MCP relay** (the CLI agent drives the Figma canvas)
- `GET  /mcp/events?session=…` → SSE; the plugin receives tool-call requests
  (`data: {"callId","name","args"}`).
- `POST /mcp/result` → body `{ session, callId, ok, result?, error? }`; the
  plugin returns a tool result.
- `POST /mcp/call` → body `{ session, name, args }`; called by `mcp-server.mjs`,
  blocks until the plugin returns the result.
- `POST /run-agent` → body `{ session, cli, model, task }`; spawns the CLI agent
  wired to the MCP server, streams its text as SSE.

`bridge/mcp-server.mjs` is a standalone stdio MCP server (newline-delimited
JSON-RPC) exposing the Figma tools defined in `bridge/tools.mjs`. The bridge spawns the CLI with a generated
MCP config pointing at it; each `tools/call` is relayed through `/mcp/call`.

### Claude MCP flags (version-sensitive)

The bridge launches Claude roughly as:

```
claude --print --mcp-config <tmp.json> --strict-mcp-config \
  --allowedTools mcp__figma__get_selection,… --output-format text   # task on stdin
```

Verified end-to-end with **claude 2.1.284** (the CLI discovered the MCP tools,
called them through the relay without a permission prompt, and answered). After
upgrading the CLI, re-check with `npm run smoke:mcp` while the bridge is running
— it plays the plugin's side of the relay and prints PASS/FAIL. If a newer
version renames these flags or starts prompting for tool permission, adjust the
`args` array in `/run-agent` inside `server.mjs` (e.g. add a permission-mode
flag). The generated config registers a stdio MCP server:
`{ "mcpServers": { "figma": { "command": "node", "args": ["mcp-server.mjs"],
"env": { "BRIDGE_PORT", "MCP_SESSION" } } } }`.

## CLI invocation (adjust if a CLI changes its flags)

| Provider | Command |
|---|---|
| `claude`   | `claude --print [--model <m>]` |
| `codex`    | `codex exec [-m <m>] -` |
| `opencode` | `opencode run [-m <m>]` |

The prompt is always written to the CLI's **stdin** (not argv), so long
conversations don't hit the OS argument-length limit or show up in `ps`.

A model of `default` means "use the CLI's own configured model" (no `--model`
flag passed). All of these live in `CLIS` at the top of `server.mjs`.

## Notes & security

- Binds to `127.0.0.1` only and requires the token on every call. CORS only
  allows the plugin's opaque `null` origin (add others with
  `BRIDGE_ALLOW_ORIGINS=a,b`), and the `Host` header must be
  `localhost`/`127.0.0.1` to block DNS rebinding. It still executes local CLIs
  on request — treat it as a local dev tool and don't expose the port.
- `localhost` HTTP is reachable from the plugin even though Figma runs over
  HTTPS (browsers treat localhost as a secure context). The plugin manifest
  already allows all network domains.
- Two modes: one-shot **generate** (CLI returns HTML → plugin imports it) and the
  **MCP relay**, where the CLI agent edits the canvas directly through Figma
  tools. Pick the matching provider + mode in the plugin's AI Agent tab.
