/**
 * Figma tool definitions exposed over MCP (Phase 5). Single source for the
 * bridge: `mcp-server.mjs` serves these via tools/list and `server.mjs` derives
 * the `--allowedTools` list from them. Keep in sync with `CANVAS_TOOLS` in
 * src/ui/ai/tools.ts (checked by `npm test`).
 */
export const TOOLS = [
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
    name: 'export_html',
    description: 'Export Figma frames to code. Returns the generated files (HTML/CSS, Tailwind or React JSX); image files are referenced as assets/<name>. Omit ids to use the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['html', 'tailwind', 'react', 'react-tailwind'] },
        layout: { type: 'string', enum: ['fixed', 'fluid', 'scale'] },
      },
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
