import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, buildAgentSystemPrompt, CANVAS_TOOLS } from '../../src/ui/ai/tools';
import { extractHtml } from '../../src/ui/ai/prompt';
import { readSse } from '../../src/ui/ai/sse';
// @ts-ignore — plain ESM module without type declarations
import { TOOLS as MCP_TOOLS } from '../../bridge/tools.mjs';

test('parseToolCalls: reads every tool/json fence with a "tool" field', () => {
  const text = [
    'Let me look first.',
    '```tool\n{"tool":"get_selection","args":{}}\n```',
    '```json\n{"tool":"set_fill","args":{"color":"#fff"}}\n```',
    '```tool\n{"tool":"rename_nodes"}\n```',
  ].join('\n');
  assert.deepEqual(parseToolCalls(text), [
    { tool: 'get_selection', args: {} },
    { tool: 'set_fill', args: { color: '#fff' } },
    { tool: 'rename_nodes', args: {} },
  ]);
});

test('parseToolCalls: skips invalid JSON, non-tool JSON and other fences', () => {
  const text = [
    '```tool\n{not json}\n```',
    '```json\n{"foo":1}\n```',
    '```html\n<div>{"tool":"x"}</div>\n```',
  ].join('\n');
  assert.deepEqual(parseToolCalls(text), []);
});

test('buildAgentSystemPrompt lists every canvas tool', () => {
  const prompt = buildAgentSystemPrompt();
  for (const t of CANVAS_TOOLS) assert.ok(prompt.includes(`- ${t.name}:`), t.name);
});

test('UI tool catalogue and bridge MCP tool list stay in sync', () => {
  const ui = CANVAS_TOOLS.map((t) => t.name).sort();
  const mcp = (MCP_TOOLS as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(mcp, ui);
});

test('extractHtml: strips fences and leading prose', () => {
  assert.equal(extractHtml('Here you go:\n```html\n<!doctype html><html></html>\n```\nEnjoy'), '<!doctype html><html></html>');
  assert.equal(extractHtml('Sure! <div class="a">x</div>'), '<div class="a">x</div>');
  assert.equal(extractHtml('no markup at all'), 'no markup at all');
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

test('readSse: reassembles events split across chunks, ignores [DONE] and comments', async () => {
  const events: unknown[] = [];
  await readSse(
    streamOf([': hb\n\ndata: {"text":"he', 'llo"}\n\ndata: {"text":"!"}\n', '\ndata: [DONE]\n\n']),
    (e) => events.push(e),
  );
  assert.deepEqual(events, [{ text: 'hello' }, { text: '!' }]);
});
