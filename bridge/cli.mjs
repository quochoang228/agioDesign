#!/usr/bin/env node
/**
 * Single entry point for the packaged bridge executable (`npm run package`
 * compiles this with bun into one file per OS, so users need no Node.js):
 *
 *   agiodesign-bridge            → install (what a double-click does)
 *   agiodesign-bridge serve      → run the bridge server (used by the login item)
 *   agiodesign-bridge mcp        → stdio MCP server (spawned for the CLI agent)
 *   agiodesign-bridge uninstall | status
 */
const cmd = process.argv[2] || 'install';

if (cmd === 'serve') await import('./server.mjs');
else if (cmd === 'mcp') await import('./mcp-server.mjs');
else await import('./install.mjs');
