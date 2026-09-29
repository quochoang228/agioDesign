/**
 * Agent tool catalogue (UI side). These descriptions are rendered into the agent
 * system prompt; the actual implementations live in `src/main/tools.ts` and run
 * in the sandbox. The agent emits ```tool fenced JSON blocks to call them.
 */

export interface ToolSpec {
  name: string;
  desc: string;
  args: string;
}

export const CANVAS_TOOLS: ToolSpec[] = [
  { name: 'get_selection', desc: 'List currently selected nodes (id, name, type, x, y, w, h).', args: '{}' },
  { name: 'get_page_summary', desc: 'List top-level nodes on the current page.', args: '{}' },
  {
    name: 'get_design_system',
    desc: 'List local paint styles, text styles, and components (id + name) to reuse.',
    args: '{}',
  },
  {
    name: 'rename_nodes',
    desc: 'Rename one or more nodes by id.',
    args: '{"renames":[{"id":"1:2","name":"Header"}]}',
  },
  {
    name: 'set_auto_layout',
    desc: 'Apply auto layout to a frame/component.',
    args: '{"id":"1:2","direction":"VERTICAL","itemSpacing":16,"padding":24,"primaryAxisAlign":"MIN","counterAxisAlign":"MIN"}',
  },
  {
    name: 'align_nodes',
    desc: 'Align nodes that share a parent. axis: left|right|top|bottom|center-x|center-y. Optional distribute: horizontal|vertical. Omit "ids" to use the selection.',
    args: '{"ids":["1:2","1:3"],"axis":"left"}',
  },
  {
    name: 'set_fill',
    desc: 'Set a solid fill colour on nodes. Omit "ids" to use the selection.',
    args: '{"ids":["1:2"],"color":"#6366f1","opacity":1}',
  },
  { name: 'set_text', desc: 'Replace the characters of a TEXT node.', args: '{"id":"1:2","characters":"Hello"}' },
  {
    name: 'generate_image',
    desc: 'Generate an image from a prompt and place it on the canvas, or fill a node when "targetId" is given. Needs an image key in Settings.',
    args: '{"prompt":"a soft gradient hero background","width":1024,"height":1024,"targetId":"1:2"}',
  },
  { name: 'web_fetch', desc: 'Fetch the readable text of a URL.', args: '{"url":"https://example.com"}' },
  { name: 'web_search', desc: 'Search the web (needs the local bridge). Returns top results.', args: '{"query":"latest design system trends"}' },
];

export function buildAgentSystemPrompt(): string {
  const list = CANVAS_TOOLS.map((t) => `- ${t.name}: ${t.desc}\n  args: ${t.args}`).join('\n');
  return `You are a Figma design agent operating on the user's current page. You can inspect and edit it by calling tools.

To call tools, output one or more fenced blocks, each a single JSON object:
\`\`\`tool
{"tool":"<name>","args":{ ... }}
\`\`\`
Emit several tool blocks in one reply to batch related actions. After each reply you receive the results, then continue. When the task is fully done, reply with a short plain-text summary and NO tool block.

Rules:
- Node ids come ONLY from get_selection or get_page_summary — call those first, never invent ids.
- Tools with an "ids" field use the current selection when "ids" is omitted.
- Inspect before editing; batch related edits; keep going until done, then summarise briefly.

Available tools:
${list}`;
}

export interface ToolCall {
  tool: string;
  args: any;
}

/** Pull every ```tool / ```json block whose JSON has a "tool" field. */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const re = /```(?:tool|json)\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.tool === 'string') calls.push({ tool: obj.tool, args: obj.args ?? {} });
    } catch {
      /* skip non-JSON fences */
    }
  }
  return calls;
}
