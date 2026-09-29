/* Test harness: runs the real converter on a sample, then renders the resulting
   LayerNode tree back into absolutely-positioned DOM — approximating how Figma
   would paint it — so we can visually verify fidelity. Not shipped. */
import { htmlToLayerTree } from '../src/ui/converter';
import type { LayerNode, RGBA } from '../src/shared/types';

// Fetch the sample from ?file= so large JS-app exports don't need inlining.
async function loadSample(): Promise<string> {
  const file = new URLSearchParams(location.search).get('file') || 'sample.html';
  return (await fetch('/' + file)).text();
}

const rgba = (c: RGBA) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

function bytesToUrl(bytes: Uint8Array): string {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  return URL.createObjectURL(blob);
}

function paintCss(node: LayerNode): { bg?: string; img?: string } {
  if (!node.fills?.length) return {};
  const bgs: string[] = [];
  for (const f of node.fills) {
    if (f.type === 'SOLID') bgs.push(`linear-gradient(${rgba(f.color)},${rgba(f.color)})`);
    else if (f.type === 'GRADIENT_LINEAR')
      bgs.push(`linear-gradient(${f.angle}deg,${f.stops.map((s) => `${rgba(s.color)} ${s.position * 100}%`).join(',')})`);
    else if (f.type === 'GRADIENT_RADIAL')
      bgs.push(`radial-gradient(${f.stops.map((s) => `${rgba(s.color)} ${s.position * 100}%`).join(',')})`);
    else if (f.type === 'IMAGE' && f.bytes.length)
      bgs.push(`url(${bytesToUrl(f.bytes)})`);
  }
  return { bg: bgs.reverse().join(',') };
}

function renderNode(node: LayerNode, stage: HTMLElement) {
  const el = document.createElement('div');
  const s = el.style;
  s.position = 'absolute';
  s.left = node.x + 'px';
  s.top = node.y + 'px';
  s.width = node.width + 'px';
  s.height = node.height + 'px';
  s.opacity = String(node.opacity);
  if (node.cornerRadius) s.borderRadius = node.cornerRadius.map((r) => r + 'px').join(' ');
  if (node.border) {
    s.borderStyle = 'solid';
    s.borderColor = rgba(node.border.color);
    s.borderTopWidth = node.border.top + 'px';
    s.borderRightWidth = node.border.right + 'px';
    s.borderBottomWidth = node.border.bottom + 'px';
    s.borderLeftWidth = node.border.left + 'px';
  }
  const p = paintCss(node);
  if (p.bg) {
    s.backgroundImage = p.bg;
    s.backgroundSize = 'cover';
    s.backgroundRepeat = 'no-repeat';
  }
  if (node.type === 'TEXT') {
    el.textContent = node.characters;
    s.color = rgba(node.textColor);
    s.fontSize = node.fontSize + 'px';
    s.fontWeight = String(node.fontWeight);
    s.fontFamily = node.fontFamily + ', sans-serif';
    s.lineHeight = node.lineHeight + 'px';
    s.whiteSpace = node.multiline ? 'pre-wrap' : 'pre';
    s.textAlign = node.textAlign.toLowerCase();
    s.fontStyle = node.italic ? 'italic' : 'normal';
    s.overflow = 'visible';
  }
  if (node.type === 'SVG') el.innerHTML = node.svg;
  stage.appendChild(el);
  if (node.type === 'FRAME') node.children.forEach((c) => renderNode(c, stage));
}

(async () => {
  const out = document.getElementById('out')!;
  const stage = document.getElementById('stage')!;
  try {
    const sample = await loadSample();
    const { tree } = await htmlToLayerTree(sample, 470, true);
    stage.style.width = Math.ceil(tree.width) + 'px';
    stage.style.height = Math.ceil(tree.height) + 'px';
    renderNode(tree, stage);
    out.textContent = `rendered ${tree.width}x${tree.height}`;
    (window as any).__DONE__ = true;
  } catch (e) {
    out.textContent = 'ERROR: ' + (e instanceof Error ? e.stack : String(e));
    (window as any).__DONE__ = true;
  }
})();
