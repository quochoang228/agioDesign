/**
 * Figma paints → CSS images. Gradients are reconstructed from Figma's
 * `gradientTransform` (node space → gradient space) by mapping the gradient
 * handles back into the node box, so angle and stop positions match the design
 * for the frame's own aspect ratio.
 */
import type { ColorStop, ExportPaint, Transform2D } from '../shared/export';
import { num, tokenColor } from './css';

type Pt = { x: number; y: number };

function invert(m: Transform2D): Transform2D {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

const apply = (m: Transform2D, p: Pt): Pt => ({
  x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
});

function stopList(stops: ColorStop[], opacity: number, useVars: boolean, pos: (p: number) => number, unit = '%'): string {
  return stops
    .map((s) => `${tokenColor(s.color, opacity, s.variable, useVars)} ${num(pos(s.position) * 100)}${unit}`)
    .join(', ');
}

/** CSS `linear-gradient` equivalent to a Figma linear gradient on a w×h box. */
export function linearGradient(transform: Transform2D, stops: ColorStop[], w: number, h: number, opacity: number, useVars: boolean): string {
  const inv = invert(transform);
  const s = apply(inv, { x: 0, y: 0.5 });
  const e = apply(inv, { x: 1, y: 0.5 });
  const sx = s.x * w;
  const sy = s.y * h;
  const dx = e.x * w - sx;
  const dy = e.y * h - sy;
  // CSS angles are clockwise from "to top".
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const rad = (deg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const len = Math.abs(w * ux) + Math.abs(h * uy) || 1;
  const t = (px: number, py: number) => ((px - w / 2) * ux + (py - h / 2) * uy) / len + 0.5;
  const t0 = t(sx, sy);
  const t1 = t(e.x * w, e.y * h);
  return `linear-gradient(${num(deg)}deg, ${stopList(stops, opacity, useVars, (p) => t0 + p * (t1 - t0))})`;
}

export function radialGradient(transform: Transform2D, stops: ColorStop[], w: number, h: number, opacity: number, useVars: boolean): string {
  const inv = invert(transform);
  const c = apply(inv, { x: 0.5, y: 0.5 });
  const h1 = apply(inv, { x: 1, y: 0.5 });
  const h2 = apply(inv, { x: 0.5, y: 1 });
  const rx = Math.hypot((h1.x - c.x) * w, (h1.y - c.y) * h);
  const ry = Math.hypot((h2.x - c.x) * w, (h2.y - c.y) * h);
  const size = `${num((rx / (w || 1)) * 100)}% ${num((ry / (h || 1)) * 100)}%`;
  return `radial-gradient(${size} at ${num(c.x * 100)}% ${num(c.y * 100)}%, ${stopList(stops, opacity, useVars, (p) => p)})`;
}

export function conicGradient(transform: Transform2D, stops: ColorStop[], w: number, h: number, opacity: number, useVars: boolean): string {
  const inv = invert(transform);
  const c = apply(inv, { x: 0.5, y: 0.5 });
  const h1 = apply(inv, { x: 1, y: 0.5 });
  let deg = (Math.atan2((h1.x - c.x) * w, -(h1.y - c.y) * h) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const list = stops
    .map((s) => `${tokenColor(s.color, opacity, s.variable, useVars)} ${num(s.position * 360)}deg`)
    .join(', ');
  return `conic-gradient(from ${num(deg)}deg at ${num(c.x * 100)}% ${num(c.y * 100)}%, ${list})`;
}

export function gradientCss(p: Extract<ExportPaint, { stops: ColorStop[] }>, w: number, h: number, useVars: boolean): string {
  if (p.type === 'GRADIENT_LINEAR') return linearGradient(p.transform, p.stops, w, h, p.opacity, useVars);
  if (p.type === 'GRADIENT_ANGULAR') return conicGradient(p.transform, p.stops, w, h, p.opacity, useVars);
  return radialGradient(p.transform, p.stops, w, h, p.opacity, useVars);
}

export interface BgContext {
  width: number;
  height: number;
  useVars: boolean;
  assetUrl: (id: string) => string;
  /** When true, sizes use % so the background follows a fluid box. */
  fluid: boolean;
  warn: (msg: string) => void;
}

/** One CSS background layer for an image paint. */
function imageLayer(p: Extract<ExportPaint, { type: 'IMAGE' }>, ctx: BgContext): string {
  const url = `url("${ctx.assetUrl(p.assetId)}")`;
  if (p.opacity < 0.999) ctx.warn('Image fill opacity is not supported in CSS backgrounds; exported at full opacity.');
  switch (p.scaleMode) {
    case 'FIT':
      return `${url} center / contain no-repeat`;
    case 'TILE': {
      const f = p.scalingFactor ?? 1;
      return `${url} 0 0 / ${num(f * 100)}% repeat`;
    }
    case 'CROP': {
      const t = p.imageTransform;
      if (!t || Math.abs(t[0][1]) > 1e-4 || Math.abs(t[1][0]) > 1e-4) return `${url} center / cover no-repeat`;
      const a = t[0][0] || 1;
      const d = t[1][1] || 1;
      const tx = t[0][2];
      const ty = t[1][2];
      const px = Math.abs(1 - a) < 1e-4 ? 0 : (tx / (1 - a)) * 100;
      const py = Math.abs(1 - d) < 1e-4 ? 0 : (ty / (1 - d)) * 100;
      return `${url} ${num(px)}% ${num(py)}% / ${num(100 / a)}% ${num(100 / d)}% no-repeat`;
    }
    default:
      return `${url} center / cover no-repeat`;
  }
}

/**
 * Figma fills (bottom → top) → a CSS `background` value (top layer first), or
 * undefined when there is nothing visible.
 */
export function backgroundCss(fills: ExportPaint[], ctx: BgContext): string | undefined {
  if (!fills.length) return undefined;
  const layers: string[] = [];
  let color: string | undefined;
  fills.forEach((p, i) => {
    let layer: string;
    if (p.type === 'SOLID') {
      const c = tokenColor(p.color, 1, p.variable, ctx.useVars);
      if (i === 0) {
        color = c;
        return;
      }
      layer = `linear-gradient(${c}, ${c})`;
    } else if (p.type === 'IMAGE') {
      layer = imageLayer(p, ctx);
    } else {
      layer = gradientCss(p, ctx.width, ctx.height, ctx.useVars);
    }
    layers.unshift(layer);
  });
  if (color) layers.push(color);
  return layers.join(', ') || undefined;
}

/** First usable flat colour of a paint list (for strokes/text fallbacks). */
export function firstColor(fills: ExportPaint[], useVars: boolean): string | undefined {
  for (let i = fills.length - 1; i >= 0; i--) {
    const p = fills[i];
    if (p.type === 'SOLID') return tokenColor(p.color, 1, p.variable, useVars);
    if (p.type !== 'IMAGE' && p.stops.length) return tokenColor(p.stops[0].color, p.opacity, p.stops[0].variable, useVars);
  }
  return undefined;
}
