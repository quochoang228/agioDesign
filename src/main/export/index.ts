/**
 * Sandbox side of Figma → HTML: selection tracking, serialising the selection
 * for the UI's Code tab, the `export_html` agent tool, and Dev Mode codegen.
 * The UI and codegen share the same pure generator (`src/codegen`).
 */
import type { ExportBundle, ExportFormat, ExportLayout, ExportOptions, SelectionItem } from '../../shared/export';
import { DEFAULT_EXPORT_OPTIONS } from '../../shared/export';
import { generate } from '../../codegen';
import { countNodes, serializeNodes } from './serialize';

export const EXPORT_KEY = 'agiodesign:export';

export function selectionItems(): SelectionItem[] {
  return figma.currentPage.selection.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    width: Math.round('width' in n ? n.width : 0),
    height: Math.round('height' in n ? n.height : 0),
  }));
}

export async function loadExportOptions(): Promise<ExportOptions> {
  try {
    const saved = (await figma.clientStorage.getAsync(EXPORT_KEY)) as Partial<ExportOptions> | undefined;
    return { ...DEFAULT_EXPORT_OPTIONS, ...(saved || {}) };
  } catch {
    return DEFAULT_EXPORT_OPTIONS;
  }
}

async function resolveNodes(ids?: string[]): Promise<SceneNode[]> {
  if (ids && ids.length) {
    const out: SceneNode[] = [];
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') out.push(n as SceneNode);
    }
    return out;
  }
  return [...figma.currentPage.selection];
}

export async function exportSelection(
  ids: string[] | undefined,
  density: 1 | 2 | 3,
  srcset: boolean,
  onProgress: (done: number, total: number) => void,
): Promise<ExportBundle> {
  const nodes = await resolveNodes(ids);
  if (!nodes.length) throw new Error('Select one or more frames to export.');
  const total = countNodes(nodes);
  const bundle = await serializeNodes(nodes, { density, srcset, onProgress: (d) => onProgress(d, total) });
  onProgress(total, total);
  return bundle;
}

const FORMATS: ExportFormat[] = ['html', 'tailwind', 'react', 'react-tailwind'];
const LAYOUTS: ExportLayout[] = ['fixed', 'fluid', 'scale'];
const MAX_TOOL_CHARS = 60000;

/** Agent tool: export nodes (or the selection) to code, without image bytes. */
export async function exportHtmlTool(args: { ids?: string[]; format?: string; layout?: string }): Promise<unknown> {
  const nodes = await resolveNodes(args?.ids);
  if (!nodes.length) throw new Error('Nothing selected — pass "ids" or select a frame.');
  const bundle = await serializeNodes(nodes, { density: 2, srcset: false });
  const options: ExportOptions = {
    ...(await loadExportOptions()),
    format: FORMATS.includes(args?.format as ExportFormat) ? (args.format as ExportFormat) : 'html',
    layout: LAYOUTS.includes(args?.layout as ExportLayout) ? (args.layout as ExportLayout) : 'fluid',
    images: 'files',
  };
  const r = generate({ bundle, options, target: 'download' });
  const clip = (s: string) => (s.length > MAX_TOOL_CHARS ? s.slice(0, MAX_TOOL_CHARS) + '\n<!-- truncated -->' : s);
  return {
    format: options.format,
    files: r.tabs.map((t) => ({ name: t.label, content: clip(t.content) })),
    images: bundle.assets.map((a) => `assets/${a.name}`),
    warnings: r.warnings.map((w) => (w.nodeName ? `${w.nodeName}: ${w.message}` : w.message)),
  };
}

/** Dev Mode code generator: HTML / Tailwind / React for the inspected node. */
export function setupCodegen(): void {
  figma.codegen.on('generate', async ({ node, language }) => {
    const bundle = await serializeNodes([node], { density: 2, srcset: false });
    const format: ExportFormat = language === 'tailwind' ? 'tailwind' : language === 'react' ? 'react' : 'html';
    const options: ExportOptions = { ...(await loadExportOptions()), format, images: 'files', cssMode: 'style-tag' };
    const r = generate({ bundle, options, target: 'download' });
    const out: CodegenResult[] = [];
    if (format === 'react') {
      out.push({ title: 'JSX', language: 'JAVASCRIPT', code: r.parts.jsx ?? '' });
      out.push({ title: 'CSS', language: 'CSS', code: r.parts.css });
    } else {
      out.push({ title: format === 'tailwind' ? 'Tailwind' : 'HTML', language: 'HTML', code: r.parts.markup });
      if (format === 'html') out.push({ title: 'CSS', language: 'CSS', code: r.parts.css });
    }
    if (r.warnings.length) {
      out.push({
        title: 'Warnings',
        language: 'PLAINTEXT',
        code: r.warnings.map((w) => (w.nodeName ? `${w.nodeName}: ${w.message}` : w.message)).join('\n'),
      });
    }
    return out;
  });
}
