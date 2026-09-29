/* Round-trip fidelity harness (not shipped): HTML → LayerNode (the real
   converter) → ExportNode (mirroring what builder.ts creates in Figma) → HTML
   (the real generator). Shows the source and the regenerated page side by side
   so export fidelity can be checked without Figma.
   Build: `npm run roundtrip`, serve the repo root, open
   /test/roundtrip.html?file=sample.html&layout=fixed&autolayout=1 */
import { htmlToLayerTree } from '../src/ui/converter';
import type { LayerNode, PaintData } from '../src/shared/types';
import type { ExportAsset, ExportNode, ExportPaint, ExportOptions, Transform2D } from '../src/shared/export';
import { DEFAULT_EXPORT_OPTIONS } from '../src/shared/export';
import { generate } from '../src/codegen';

const params = new URLSearchParams(location.search);
const WIDTH = Number(params.get('width') || 1280);
const AUTO_LAYOUT = params.get('autolayout') === '1';

// Same maths as builder.ts (CSS angle → Figma gradientTransform).
function linearTransform(angleDeg: number): Transform2D {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const s = 1 / (Math.abs(dx) + Math.abs(dy) || 1);
  return [
    [s * dx, s * dy, 0.5 - 0.5 * s * (dx + dy)],
    [-s * dy, s * dx, 0.5 + 0.5 * s * (dy - dx)],
  ];
}

let assetSeq = 0;
const assets: ExportAsset[] = [];

function paints(list: PaintData[] | undefined): ExportPaint[] {
  const out: ExportPaint[] = [];
  for (const p of list ?? []) {
    if (p.type === 'SOLID') out.push({ type: 'SOLID', color: p.color });
    else if (p.type === 'IMAGE') {
      if (!p.bytes.length) continue;
      const id = `a${++assetSeq}`;
      assets.push({ id, name: `image-${assetSeq}`, mime: 'image/png', bytes: p.bytes });
      out.push({ type: 'IMAGE', assetId: id, scaleMode: p.scaleMode, opacity: 1, scalingFactor: 0.5 });
    } else {
      out.push({
        type: p.type,
        stops: p.stops,
        transform: p.type === 'GRADIENT_RADIAL' ? [[0.5, 0, 0.25], [0, 0.5, 0.25]] : linearTransform(p.angle),
        opacity: 1,
      });
    }
  }
  return out;
}

function convert(layer: LayerNode, parent: LayerNode | null, parentFlow: boolean, flowDir?: 'HORIZONTAL' | 'VERTICAL'): ExportNode {
  const base = {
    id: `n${Math.random().toString(36).slice(2, 8)}`,
    name: layer.name || layer.type.toLowerCase(),
    x: parent ? layer.x - parent.x : 0,
    y: parent ? layer.y - parent.y : 0,
    width: layer.width,
    height: layer.height,
    opacity: layer.opacity,
    absolute: !parentFlow,
    sizingH: 'FIXED' as const,
    sizingV: 'FIXED' as const,
    constraints: { h: 'MIN' as const, v: 'MIN' as const },
    fills: paints(layer.fills),
    effects: (layer.shadows ?? []).map((s) => ({
      type: s.inset ? ('INNER_SHADOW' as const) : ('DROP_SHADOW' as const),
      color: s.color,
      x: s.offsetX,
      y: s.offsetY,
      blur: s.blur,
      spread: s.spread,
    })),
    radius: layer.cornerRadius,
    stroke: layer.border
      ? {
          paints: [{ type: 'SOLID' as const, color: layer.border.color }],
          weights: [layer.border.top, layer.border.right, layer.border.bottom, layer.border.left] as [number, number, number, number],
          align: 'INSIDE' as const,
          dashed: false,
        }
      : undefined,
  };
  if (parentFlow && layer.flexGrow) {
    if (flowDir === 'HORIZONTAL') base.sizingH = 'FILL' as never;
    else base.sizingV = 'FILL' as never;
  }

  if (layer.type === 'TEXT') {
    const runs = (layer.runs?.length ? layer.runs : [{ start: 0, end: layer.characters.length, fontFamily: layer.fontFamily, fontWeight: layer.fontWeight, italic: layer.italic, fontSize: layer.fontSize, color: layer.textColor, textDecoration: layer.textDecoration, letterSpacing: layer.letterSpacing }]).map((r) => ({
      start: r.start,
      end: r.end,
      fontFamily: r.fontFamily,
      fontWeight: r.fontWeight,
      italic: r.italic,
      fontSize: r.fontSize,
      lineHeight: { unit: 'PX' as const, value: layer.lineHeight },
      letterSpacing: { unit: 'PX' as const, value: r.letterSpacing },
      fills: [{ type: 'SOLID' as const, color: r.color }],
      decoration: r.textDecoration,
      textCase: layer.textCase,
    }));
    return {
      ...base,
      fills: [],
      kind: 'TEXT',
      characters: layer.characters,
      runs,
      alignH: layer.textAlign,
      alignV: 'TOP',
      autoResize: layer.multiline ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
      sizingH: layer.multiline ? 'FIXED' : 'HUG',
      sizingV: 'HUG',
    };
  }
  if (layer.type === 'SVG') return { ...base, kind: 'SVG', svg: layer.svg, fills: [], effects: [] };
  if (layer.type === 'IMAGE') return { ...base, kind: 'FRAME', clips: true, children: [] };

  const flow = AUTO_LAYOUT && !!layer.autoLayout;
  const al = layer.autoLayout;
  return {
    ...base,
    kind: 'FRAME',
    clips: !!layer.clipsContent,
    layout:
      flow && al
        ? {
            direction: al.mode === 'HORIZONTAL' ? 'ROW' : 'COLUMN',
            wrap: false,
            gap: al.itemSpacing,
            crossGap: 0,
            padding: [al.paddingTop, al.paddingRight, al.paddingBottom, al.paddingLeft],
            justify: al.primaryAxisAlign,
            align: al.counterAxisAlign,
          }
        : undefined,
    children: layer.children.map((c) => convert(c, layer, flow, al?.mode)),
  };
}

async function main() {
  const out = document.getElementById('out')!;
  const file = params.get('file') || 'sample.html';
  const html = await (await fetch('/' + file)).text();
  const { tree } = await htmlToLayerTree(html, WIDTH, true);
  const root = convert(tree, null, false);
  const options: ExportOptions = {
    ...DEFAULT_EXPORT_OPTIONS,
    layout: (params.get('layout') as ExportOptions['layout']) || 'fixed',
    format: (params.get('format') as ExportOptions['format']) || 'html',
  };
  const r = generate({ bundle: { roots: [root], assets, warnings: [], variables: {} }, options, target: 'preview' });

  const left = document.getElementById('src') as HTMLIFrameElement;
  const right = document.getElementById('gen') as HTMLIFrameElement;
  for (const f of [left, right]) f.style.width = `${WIDTH}px`;
  left.srcdoc = html;
  right.srcdoc = r.document;
  out.textContent = `${r.stats.elements} elements · ${r.stats.classes} classes · ${r.warnings.length} warnings · ${(r.document.length / 1024).toFixed(0)} KB`;
  (window as unknown as { __result: unknown }).__result = r;
}

main().catch((e) => {
  document.getElementById('out')!.textContent = 'ERROR ' + (e?.stack || e);
});
