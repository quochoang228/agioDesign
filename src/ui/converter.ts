/**
 * DOM → LayerNode converter. Runs inside the plugin UI iframe, which has a real
 * browser DOM. We render the user's HTML into an offscreen container, let the
 * browser do layout, then walk the rendered tree reading geometry from
 * `getBoundingClientRect` and styling from `getComputedStyle`. The result is a
 * plain serialisable tree the sandbox can rebuild as Figma nodes.
 */
import type {
  LayerNode,
  FrameLayer,
  TextLayer,
  PaintData,
  RGBA,
  ShadowData,
  BorderData,
  AutoLayoutData,
  GradientStopData,
  GradientPaintData,
  StyleRun,
} from '../shared/types';
import { px, splitTopLevelCommas, parseGradientAngle, mapFontWeight, bgScaleMode } from './cssParse';

const FALLBACK_SIZE = 1280;

/**
 * The rendering context. We render into an offscreen <iframe> so a full HTML
 * document (with <head> styles and <body> background) is honoured exactly as a
 * browser would, then read geometry/styles from THAT window & document. These
 * are repointed at the iframe for the duration of a render.
 */
let win: Window & typeof globalThis = window;
let doc: Document = document;

export interface RenderResult {
  tree: LayerNode;
  /** distinct "family:weight:italic" combos used, for the sandbox to preload */
  fonts: string[];
}

/**
 * Resolve ANY CSS colour to RGBA by letting the browser paint it on a 1×1
 * canvas and reading the pixel back. This handles rgb()/rgba(), hex, hsl(),
 * named colours and — crucially — modern `oklch()`/`lab()`/`color()` which
 * `getComputedStyle` returns verbatim and a regex would miss entirely.
 */
const _swatch = document.createElement('canvas');
_swatch.width = _swatch.height = 1;
const _swatchCtx = _swatch.getContext('2d', { willReadFrequently: true });

function cssColorRGBA(value: string): RGBA | null {
  const v = (value || '').trim();
  if (!v || v === 'none' || v === 'currentColor') return null;
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const ctx = _swatchCtx;
  if (!ctx) return null;
  // Detect parse failure: an invalid value leaves fillStyle at the prior value,
  // so two different sentinels would disagree.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = v;
  const first = ctx.fillStyle;
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = v;
  if (ctx.fillStyle !== first) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
}

/** Opaque-or-translucent colour for fills/borders/text; null if fully transparent. */
function parseColor(value: string): RGBA | null {
  const c = cssColorRGBA(value);
  return c && c.a > 0 ? c : null;
}

/** Colour for gradient stops — keeps fully-transparent stops (they matter). */
function parseStopColor(value: string): RGBA | null {
  return cssColorRGBA(value);
}

const COLOR_TOKEN =
  /(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b[a-z]+\b/i;

function parseShadows(value: string): ShadowData[] {
  if (!value || value === 'none') return [];
  const shadows: ShadowData[] = [];
  const parts = splitTopLevelCommas(value);
  for (const raw of parts) {
    const inset = /\binset\b/.test(raw);
    const part = raw.replace(/\binset\b/, ' ');
    // The colour is the leading non-length token (Chrome serialises it first).
    const colorMatch = part.match(COLOR_TOKEN);
    const color = colorMatch ? cssColorRGBA(colorMatch[0]) : { r: 0, g: 0, b: 0, a: 0.25 };
    if (!color) continue;
    const nums = (colorMatch ? part.replace(colorMatch[0], ' ') : part).match(/-?[\d.]+px/g) || [];
    const [ox = '0', oy = '0', blur = '0', spread = '0'] = nums;
    shadows.push({
      color,
      offsetX: px(ox),
      offsetY: px(oy),
      blur: px(blur),
      spread: px(spread),
      inset,
    });
  }
  return shadows;
}

function parseRadius(style: CSSStyleDeclaration): [number, number, number, number] {
  return [
    px(style.borderTopLeftRadius),
    px(style.borderTopRightRadius),
    px(style.borderBottomRightRadius),
    px(style.borderBottomLeftRadius),
  ];
}

/** Read each side's border independently; pick a representative colour. */
function parseBorder(style: CSSStyleDeclaration): BorderData | undefined {
  const side = (w: string, s: string, c: string) => {
    const weight = px(w);
    if (weight <= 0 || s === 'none' || s === 'hidden') return { weight: 0, color: null as RGBA | null };
    return { weight, color: parseColor(c) };
  };
  const top = side(style.borderTopWidth, style.borderTopStyle, style.borderTopColor);
  const right = side(style.borderRightWidth, style.borderRightStyle, style.borderRightColor);
  const bottom = side(style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor);
  const left = side(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor);
  // The colour of the heaviest visible side represents the stroke (Figma allows
  // one stroke colour but per-side weights).
  const heaviest = [top, right, bottom, left]
    .filter((s) => s.weight > 0 && s.color)
    .sort((a, b) => b.weight - a.weight)[0];
  if (!heaviest || !heaviest.color) return undefined;
  return {
    color: heaviest.color,
    top: top.color ? top.weight : 0,
    right: right.color ? right.weight : 0,
    bottom: bottom.color ? bottom.weight : 0,
    left: left.color ? left.weight : 0,
  };
}

/** Split one "<color> [pos%]" stop segment into its colour and optional position. */
function parseStopSegment(seg: string): { color: RGBA | null; position: number | null } {
  let s = seg.trim();
  let colorStr = '';
  const fh = s.match(
    /^(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[0-9a-fA-F]{3,8})/i,
  );
  if (fh) {
    colorStr = fh[0];
    s = s.slice(fh[0].length);
  } else {
    const word = s.match(/^[a-zA-Z]+/); // named colour (or a direction keyword)
    if (word) {
      colorStr = word[0];
      s = s.slice(word[0].length);
    }
  }
  const color = parseStopColor(colorStr);
  const posMatch = s.match(/(-?[\d.]+)%/); // position is read AFTER the colour token
  return { color, position: posMatch ? parseFloat(posMatch[1]) / 100 : null };
}

/** Parse colour stops, filling missing positions by even distribution. */
function parseStops(segments: string[]): GradientStopData[] {
  const raw = segments
    .map((seg) => parseStopSegment(seg))
    .filter((s): s is { color: RGBA; position: number | null } => s.color !== null);
  const n = raw.length;
  return raw.map((s, i) => ({
    color: s.color,
    position: s.position ?? (n <= 1 ? 0 : i / (n - 1)),
  }));
}

/** Parse one linear/radial/conic gradient layer into a Figma gradient paint. */
function parseGradient(image: string): GradientPaintData | null {
  const isRadial = /radial-gradient/.test(image);
  const isConic = /conic-gradient/.test(image);
  const m = image.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\(([^]*)\)\s*$/);
  if (!m) return null;
  const segments = splitTopLevelCommas(m[1]);

  let angle = 180;
  let stopSegs = segments;
  // The first segment is a direction/shape descriptor if it isn't a valid colour.
  if (segments.length && parseStopSegment(segments[0]).color === null) {
    if (!isRadial && !isConic) angle = parseGradientAngle(segments[0]);
    stopSegs = segments.slice(1);
  }

  const stops = parseStops(stopSegs);
  if (stops.length < 2) return null;
  // Figma has no conic paint — approximate a conic with a radial gradient.
  return { type: isRadial || isConic ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR', stops, angle };
}

/** Map CSS flex alignment keywords to Figma's auto-layout enums. */
function mapJustify(v: string): AutoLayoutData['primaryAxisAlign'] {
  if (v.includes('between')) return 'SPACE_BETWEEN';
  if (v.includes('center')) return 'CENTER';
  if (v.includes('end')) return 'MAX';
  return 'MIN';
}
function mapAlign(v: string): AutoLayoutData['counterAxisAlign'] {
  if (v.includes('center')) return 'CENTER';
  if (v.includes('end')) return 'MAX';
  return 'MIN';
}

function detectAutoLayout(style: CSSStyleDeclaration): AutoLayoutData | undefined {
  if (style.display !== 'flex' && style.display !== 'inline-flex') return undefined;
  const column = style.flexDirection.startsWith('column');
  return {
    mode: column ? 'VERTICAL' : 'HORIZONTAL',
    itemSpacing: px(style.gap) || 0,
    paddingTop: px(style.paddingTop),
    paddingRight: px(style.paddingRight),
    paddingBottom: px(style.paddingBottom),
    paddingLeft: px(style.paddingLeft),
    primaryAxisAlign: mapJustify(style.justifyContent),
    counterAxisAlign: mapAlign(style.alignItems),
  };
}

/** Normalise any CSS text-align value to Figma's enum (start/end/match-parent → L/R). */
function mapTextAlign(v: string): TextLayer['textAlign'] {
  switch (v.toLowerCase()) {
    case 'center':
      return 'CENTER';
    case 'right':
    case 'end':
      return 'RIGHT';
    case 'justify':
    case 'justify-all':
      return 'JUSTIFIED';
    default:
      return 'LEFT';
  }
}

function backgroundPaints(style: CSSStyleDeclaration, baseUrl?: string): PaintData[] {
  const paints: PaintData[] = [];
  const bg = parseColor(style.backgroundColor);
  if (bg) paints.push({ type: 'SOLID', color: bg });

  const img = style.backgroundImage;
  if (img && img !== 'none') {
    // Per-layer size/repeat lists align with the (un-reversed) image layers.
    const sizes = splitTopLevelCommas(style.backgroundSize);
    const repeats = splitTopLevelCommas(style.backgroundRepeat);
    const layers = splitTopLevelCommas(img);
    const layerPaints: PaintData[] = [];
    layers.forEach((layer, i) => {
      if (/gradient\(/.test(layer)) {
        const g = parseGradient(layer);
        if (g) layerPaints.push(g);
      } else if (/^url\(/i.test(layer)) {
        // Take everything between url( … ) and strip optional quotes — the inner
        // value may itself contain ()/" (e.g. an inline SVG data URI).
        let src = layer.replace(/^url\(\s*/i, '').replace(/\s*\)\s*$/, '');
        src = src.replace(/^["']/, '').replace(/["']$/, '');
        // getComputedStyle backslash-escapes quotes inside the url() (common in
        // inline-SVG data URIs); unescape so the SVG markup is well-formed.
        src = src.replace(/\\(["'\\])/g, '$1');
        if (baseUrl && !/^(https?:|data:)/.test(src)) {
          try {
            src = new URL(src, baseUrl).href;
          } catch {
            /* keep as-is */
          }
        }
        const scaleMode = bgScaleMode(sizes[i] ?? sizes[0] ?? '', repeats[i] ?? repeats[0] ?? '');
        layerPaints.push({ type: 'IMAGE', bytes: new Uint8Array(0), scaleMode, src });
      }
    });
    // Figma paints stack bottom→top; CSS lists top first, so reverse to match.
    layerPaints.reverse();
    paints.push(...layerPaints);
  }
  return paints;
}

/** Is this element effectively invisible / zero-area and safe to skip? */
function isSkippable(el: Element, rect: DOMRect, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  if (rect.width < 0.5 || rect.height < 0.5) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'head') return true;
  return false;
}

/**
 * Union of the on-screen bounding boxes of `root` and every visible descendant.
 * Recovers a frame size when content is laid out entirely in out-of-flow boxes
 * (full-screen `position:fixed` overlays / centred modals), which contribute
 * nothing to an ancestor's own content height. Left/top are clamped to ≥0 so a
 * stray off-screen element can't balloon the frame.
 */
function visibleUnion(
  root: HTMLElement,
): { left: number; top: number; right: number; bottom: number } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (isSkippable(el, rect, win.getComputedStyle(el))) return;
    left = Math.min(left, Math.max(0, rect.left));
    top = Math.min(top, Math.max(0, rect.top));
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  };
  add(root);
  root.querySelectorAll('*').forEach(add);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** Build a TextLayer from already-resolved characters + geometry + style. */
function textLayerFrom(
  characters: string,
  rect: DOMRect,
  origin: DOMRect,
  style: CSSStyleDeclaration,
  fonts: Set<string>,
): TextLayer | null {
  if (!characters) return null;
  const color = parseColor(style.color) || { r: 0, g: 0, b: 0, a: 1 };
  const fontFamily = style.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Inter';
  const fontWeight = mapFontWeight(style.fontWeight);
  const italic = style.fontStyle === 'italic';
  fonts.add(`${fontFamily}:${fontWeight}:${italic}`);
  const lh = style.lineHeight === 'normal' ? px(style.fontSize) * 1.2 : px(style.lineHeight);
  const deco = style.textDecorationLine || style.textDecoration;
  // Single line unless the rendered box spans clearly more than one line and
  // wrapping is allowed. Single-line text hugs its content (no premature wrap).
  const nowrap = style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre';
  const multiline = !nowrap && rect.height > lh * 1.6;
  return {
    type: 'TEXT',
    name: characters.slice(0, 40) || 'Text',
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    width: Math.ceil(rect.width) + 1,
    height: Math.ceil(rect.height),
    multiline,
    opacity: parseFloat(style.opacity) || 1,
    characters,
    fontSize: px(style.fontSize) || 16,
    fontFamily,
    fontWeight,
    italic,
    lineHeight: lh,
    letterSpacing: px(style.letterSpacing) || 0,
    textAlign: mapTextAlign(style.textAlign),
    textColor: color,
    textDecoration: deco.includes('underline')
      ? 'UNDERLINE'
      : deco.includes('line-through')
        ? 'STRIKETHROUGH'
        : 'NONE',
    textCase:
      style.textTransform === 'uppercase'
        ? 'UPPER'
        : style.textTransform === 'lowercase'
          ? 'LOWER'
          : 'ORIGINAL',
  };
}

/** TextLayer for a raw text node, measured precisely with a Range. */
function makeTextNodeLayer(
  node: Text,
  parentStyle: CSSStyleDeclaration,
  origin: DOMRect,
  fonts: Set<string>,
): TextLayer | null {
  const characters = (node.textContent || '').replace(/\s+/g, ' ').trim();
  if (!characters) return null;
  const range = doc.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return null;
  return textLayerFrom(characters, rect, origin, parentStyle, fonts);
}

const REPLACED_TAGS = new Set([
  'IMG', 'SVG', 'VIDEO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT',
  'IFRAME', 'PICTURE', 'OBJECT', 'EMBED', 'HR',
]);
const BLOCK_DISPLAYS = new Set([
  'block', 'flex', 'grid', 'table', 'list-item', 'flow-root',
  'inline-block', 'inline-flex', 'inline-grid',
]);

/**
 * A "paragraph": an element holding text whose entire subtree is inline flow —
 * no block boxes, no replaced elements. Such an element must become ONE text
 * layer (with per-run styling), never split, or inline fragments overlap.
 */
function isTextContainer(el: HTMLElement): boolean {
  if (!(el.textContent || '').trim()) return false;
  const descendants = el.getElementsByTagName('*');
  for (let i = 0; i < descendants.length; i++) {
    const c = descendants[i];
    if (REPLACED_TAGS.has(c.tagName)) return false;
    const d = win.getComputedStyle(c).display;
    if (BLOCK_DISPLAYS.has(d) || d.startsWith('table')) return false;
  }
  return true;
}

function decorationOf(style: CSSStyleDeclaration): StyleRun['textDecoration'] {
  const deco = style.textDecorationLine || style.textDecoration || '';
  if (deco.includes('underline')) return 'UNDERLINE';
  if (deco.includes('line-through')) return 'STRIKETHROUGH';
  return 'NONE';
}

/** Walk a paragraph's inline subtree into one string + per-run style spans. */
function collectRuns(
  el: HTMLElement,
  fonts: Set<string>,
): { characters: string; runs: StyleRun[] } {
  let text = '';
  const runs: StyleRun[] = [];

  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const s = (child.textContent || '').replace(/\s+/g, ' ');
        if (!s) continue;
        const parent = child.parentElement || el;
        const rs = win.getComputedStyle(parent);
        const family = rs.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Inter';
        const weight = mapFontWeight(rs.fontWeight);
        const italic = rs.fontStyle === 'italic';
        fonts.add(`${family}:${weight}:${italic}`);
        const start = text.length;
        text += s;
        runs.push({
          start,
          end: text.length,
          fontFamily: family,
          fontWeight: weight,
          italic,
          fontSize: px(rs.fontSize) || 16,
          color: parseColor(rs.color) || { r: 0, g: 0, b: 0, a: 1 },
          textDecoration: decorationOf(rs),
          letterSpacing: px(rs.letterSpacing) || 0,
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if ((child as Element).tagName === 'BR') text += '\n';
        else visit(child);
      }
    }
  };
  visit(el);

  // Trim surrounding whitespace, shifting run offsets to match.
  const lead = text.length - text.replace(/^\s+/, '').length;
  const trail = text.length - text.replace(/\s+$/, '').length;
  if (lead || trail) {
    const end = text.length - trail;
    text = text.slice(lead, end);
    for (const r of runs) {
      r.start = Math.max(0, r.start - lead);
      r.end = Math.min(text.length, r.end - lead);
    }
  }
  return { characters: text, runs: runs.filter((r) => r.end > r.start) };
}

/**
 * Build a single TextLayer for a whole paragraph. Geometry comes from a Range
 * over the contents (tight, padding-free); styling comes from per-run spans so
 * bold/links/colour inside the sentence are preserved without splitting it.
 */
function buildParagraph(
  el: HTMLElement,
  origin: DOMRect,
  fonts: Set<string>,
): TextLayer | null {
  const { characters, runs } = collectRuns(el, fonts);
  if (!characters.trim()) return null;
  const style = win.getComputedStyle(el);

  let rect = el.getBoundingClientRect();
  try {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width >= 0.5 && r.height >= 0.5) rect = r;
  } catch {
    /* keep element box */
  }

  const base = textLayerFrom(characters, rect, origin, style, fonts);
  if (!base) return null;
  base.characters = characters;
  base.runs = runs;
  return base;
}

/** Computed paint/stacking order: higher z-index paints later (on top). */
function zIndexOf(style: CSSStyleDeclaration): number {
  const z = parseInt(style.zIndex, 10);
  return Number.isFinite(z) ? z : 0;
}

/**
 * Reconstruct a generated `::before`/`::after` box. Pseudo-elements have no
 * getBoundingClientRect, but their computed style resolves width/height/offsets
 * to pixels, so we can derive the box for the common decorative case (absolute
 * positioning: accent bars, dividers, dots, badges). Returns a node in absolute
 * (origin-relative) coordinates, or null when there's nothing to draw.
 */
function makePseudo(
  el: HTMLElement,
  which: '::before' | '::after',
  elRect: DOMRect,
  origin: DOMRect,
  fonts: Set<string>,
): LayerNode | null {
  const ps = win.getComputedStyle(el, which);
  if (!ps || ps.content === 'none' || ps.content === 'normal') return null;
  if (ps.position !== 'absolute' && ps.position !== 'relative') return null; // only well-defined boxes

  const num = (v: string) => (v === 'auto' || v === '' ? null : px(v));
  let w = num(ps.width);
  let h = num(ps.height);
  const l = num(ps.left);
  const r = num(ps.right);
  const t = num(ps.top);
  const b = num(ps.bottom);
  if (w == null) w = l != null && r != null ? elRect.width - l - r : 0;
  if (h == null) h = t != null && b != null ? elRect.height - t - b : 0;
  const localX = l != null ? l : r != null ? elRect.width - r - w : 0;
  const localY = t != null ? t : b != null ? elRect.height - b - h : 0;

  const text = ps.content.replace(/^["']|["']$/g, '');
  const fills = backgroundPaints(ps);
  const border = parseBorder(ps);
  const shadows = parseShadows(ps.boxShadow);
  const hasVisual = fills.length > 0 || !!border || shadows.length > 0;
  if (w <= 0 || h <= 0) return null;
  if (!hasVisual && !text) return null;

  const base = {
    x: elRect.left - origin.left + localX,
    y: elRect.top - origin.top + localY,
    width: Math.ceil(w),
    height: Math.ceil(h),
    opacity: parseFloat(ps.opacity) || 1,
    cornerRadius: parseRadius(ps),
    border,
    shadows,
    clipsContent: ps.overflow !== 'visible',
  };

  if (text && !hasVisual) {
    const t2 = textLayerFrom(text, { ...elRect, left: 0, top: 0 } as DOMRect, origin, ps, fonts);
    if (t2) {
      t2.x = base.x;
      t2.y = base.y;
      return t2;
    }
  }
  return { type: 'FRAME', name: which === '::before' ? 'before' : 'after', ...base, fills, children: [] };
}

/**
 * `figma.createNodeFromSvg` renders plain icon geometry (paths, simple
 * strokes/fills) faithfully, but DISTORTS several features: dashed strokes — the
 * single arc of a progress ring becomes a run of evenly-spaced dashes —
 * gradients, filters, masks/clip-paths and `url(#…)` paint references. An SVG
 * using any of these is reproduced exactly by rasterising it through the browser
 * instead (see `svgToDataUri`).
 *
 * `<linear|radial>gradient`, `<pattern>`, `<filter>`, `<mask>` and `<clip-path>`
 * are always present in the markup. Dashed strokes and `url(#…)` paints, though,
 * are frequently set via a CSS class or `currentColor` in the document
 * stylesheet — invisible in `outerHTML` — so we additionally probe the *computed*
 * style of every element in the subtree.
 */
const SVG_MARKUP_FEATURES =
  /<(?:linear|radial)gradient|<pattern|<filter|<mask|<clip-?path/i;

function svgNeedsRaster(el: Element): boolean {
  if (SVG_MARKUP_FEATURES.test(el.outerHTML)) return true;
  const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
  for (const node of nodes) {
    const cs = win.getComputedStyle(node);
    const dash = cs.getPropertyValue('stroke-dasharray');
    if (dash && dash !== 'none') return true;
    if (/url\(/.test(cs.getPropertyValue('fill')) || /url\(/.test(cs.getPropertyValue('stroke'))) return true;
  }
  return false;
}

/**
 * SVG presentation properties to copy from the computed style onto each element.
 * Detaching an `<svg>` from the document drops every rule that styled it through
 * a class or `currentColor` (the norm for charts), so a path meant to be a thin
 * coloured line falls back to the SVG default `fill:black; stroke:none` — a solid
 * black blob. Inlining the resolved values keeps the standalone copy faithful for
 * both the rasteriser and `createNodeFromSvg`. `transform` is intentionally
 * excluded: its computed form is a `matrix()` that differs from the SVG attribute.
 */
const SVG_STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'opacity', 'color', 'stop-color', 'stop-opacity',
  'paint-order', 'mix-blend-mode', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-anchor', 'letter-spacing',
] as const;

/** Recursively inline the computed presentation style of `src` onto clone `dst`. */
function inlineSvgStyles(src: Element, dst: Element): void {
  const cs = win.getComputedStyle(src);
  let inline = '';
  for (const prop of SVG_STYLE_PROPS) {
    const v = cs.getPropertyValue(prop);
    if (v) inline += `${prop}:${v};`;
  }
  const existing = dst.getAttribute('style');
  dst.setAttribute('style', inline + (existing || ''));
  dst.removeAttribute('class'); // its stylesheet won't travel with the clone
  const sc = src.children;
  const dc = dst.children;
  const n = Math.min(sc.length, dc.length);
  for (let i = 0; i < n; i++) inlineSvgStyles(sc[i], dc[i]);
}

/**
 * Clone a live `<svg>` into a self-contained, explicitly-sized standalone copy:
 * inline the cascaded CSS (so class-/`currentColor`-based styling survives the
 * detachment), force the SVG namespace, and pin width/height in real pixels — a
 * `width:100%` collapses to 0 once the SVG renders on its own, and the pixel size
 * is also what makes `createNodeFromSvg` build the node at the right dimensions
 * instead of the raw `viewBox` size.
 */
function selfContainedSvg(el: Element, w: number, h: number): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  inlineSvgStyles(el, clone);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.style.removeProperty('width');
  clone.style.removeProperty('height');
  return new XMLSerializer().serializeToString(clone);
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Documents of every same-origin <iframe> under `d`, nested ones included. */
function sameOriginFrameDocs(d: Document): Document[] {
  const out: Document[] = [];
  d.querySelectorAll('iframe').forEach((f) => {
    try {
      const fd = f.contentDocument;
      if (fd) out.push(fd, ...sameOriginFrameDocs(fd));
    } catch {
      /* cross-origin — can't be read, rendered as an empty box */
    }
  });
  return out;
}

/**
 * A same-origin <iframe> (design exports often mount each screen in its own
 * frame) becomes a clipping frame containing its document's layers. Returns
 * null for cross-origin/empty frames, which then fall back to a plain box.
 */
function iframeLayer(
  frameEl: HTMLIFrameElement,
  base: Omit<FrameLayer, 'type' | 'name' | 'fills' | 'children'>,
  rect: DOMRect,
  origin: DOMRect,
  fonts: Set<string>,
  importImages: boolean,
): FrameLayer | null {
  let idoc: Document | null = null;
  let iwin: (Window & typeof globalThis) | null = null;
  try {
    idoc = frameEl.contentDocument;
    iwin = frameEl.contentWindow as (Window & typeof globalThis) | null;
  } catch {
    return null;
  }
  if (!idoc?.body || !iwin) return null;

  const outerStyle = win.getComputedStyle(frameEl);
  const outerFills = backgroundPaints(outerStyle);
  // Inner rects are relative to the frame's viewport; shift the origin so
  // they land in the same coordinate space as the rest of the tree.
  const innerOrigin = {
    left: origin.left - (rect.left + frameEl.clientLeft),
    top: origin.top - (rect.top + frameEl.clientTop),
  } as DOMRect;

  const prevWin = win;
  const prevDoc = doc;
  win = iwin;
  doc = idoc;
  try {
    // The frame's canvas takes the <html> (or else <body>) background.
    const htmlFills = backgroundPaints(win.getComputedStyle(idoc.documentElement), idoc.baseURI);
    const body = walk(idoc.body, innerOrigin, fonts, importImages, idoc.baseURI);
    return {
      type: 'FRAME',
      name: frameEl.title || frameEl.name || 'iframe',
      ...base,
      clipsContent: true,
      fills: outerFills.length ? outerFills : htmlFills,
      children: body ? [body] : [],
    };
  } finally {
    win = prevWin;
    doc = prevDoc;
  }
}

/** Recursively walk a rendered element into a LayerNode. */
function walk(
  el: HTMLElement,
  origin: DOMRect,
  fonts: Set<string>,
  importImages: boolean,
  baseUrl?: string,
): LayerNode | null {
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  if (isSkippable(el, rect, style)) return null;

  const tag = el.tagName.toLowerCase();
  const base = {
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    opacity: parseFloat(style.opacity) || 1,
    cornerRadius: parseRadius(style),
    border: parseBorder(style),
    shadows: parseShadows(style.boxShadow),
    clipsContent: style.overflow !== 'visible',
    flexGrow: parseFloat(style.flexGrow) || 0,
  };

  // <img> → image layer; object-fit decides the Figma scale mode.
  if (tag === 'img' && importImages) {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    const fit = style.objectFit;
    const scaleMode = fit === 'contain' || fit === 'none' || fit === 'scale-down' ? 'FIT' : 'FILL';
    return {
      type: 'IMAGE',
      name: 'image',
      ...base,
      fills: src ? [{ type: 'IMAGE', bytes: new Uint8Array(0), scaleMode, src }] : [],
    };
  }

  // Inline SVG. Simple icons become editable vectors via createNodeFromSvg; SVGs
  // that the Figma importer mangles (dashed progress rings, gradients, filters,
  // masks…) are rasterised through the browser for pixel-perfect fidelity and
  // embedded as an image. Rasterisation rides the image pipeline, so it needs
  // image import enabled — otherwise fall back to the (imperfect) vector path.
  if (tag === 'svg') {
    if (importImages && svgNeedsRaster(el)) {
      const scale = 2; // render at 2× for crispness; Figma scales it into the box
      const w = Math.min(4096, Math.max(1, Math.round(rect.width * scale)));
      const h = Math.min(4096, Math.max(1, Math.round(rect.height * scale)));
      return {
        type: 'IMAGE',
        name: 'svg',
        ...base,
        fills: [{ type: 'IMAGE', bytes: new Uint8Array(0), scaleMode: 'FILL', src: svgToDataUri(selfContainedSvg(el, w, h)) }],
      };
    }
    return {
      type: 'SVG',
      name: 'svg',
      ...base,
      svg: selfContainedSvg(el, Math.ceil(rect.width), Math.ceil(rect.height)),
    };
  }

  if (tag === 'iframe') {
    const framed = iframeLayer(el as HTMLIFrameElement, base, rect, origin, fonts, importImages);
    if (framed) return framed;
  }

  // Inline-flow paragraph → ONE text layer (with per-run styling). If the
  // element also has a visible box (button, chip, badge…) keep a FRAME around it
  // so its background, border and radius survive, with the text nested inside.
  if (isTextContainer(el)) {
    const t = buildParagraph(el, origin, fonts);
    if (t) {
      const fills = backgroundPaints(style, baseUrl);
      const hasBox = fills.length > 0 || !!base.border || (base.shadows && base.shadows.length > 0);
      if (!hasBox) {
        t.cornerRadius = base.cornerRadius;
        return t;
      }
      const frame: FrameLayer = {
        type: 'FRAME',
        name: el.id || tag,
        ...base,
        fills,
        autoLayout: detectAutoLayout(style),
        children: [t],
      };
      return frame;
    }
  }

  // Otherwise: a frame. Walk child nodes in document order so element children
  // and the text nodes interleaved between them keep their visual sequence.
  const ordered: { node: LayerNode; z: number; seq: number }[] = [];
  let seq = 0;
  // ::before paints beneath content.
  const before = makePseudo(el, '::before', rect, origin, fonts);
  if (before) ordered.push({ node: before, z: zIndexOf(win.getComputedStyle(el, '::before')), seq: seq++ });
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const c = walk(child as HTMLElement, origin, fonts, importImages, baseUrl);
      if (c) ordered.push({ node: c, z: zIndexOf(win.getComputedStyle(child as Element)), seq: seq++ });
    } else if (child.nodeType === Node.TEXT_NODE) {
      const t = makeTextNodeLayer(child as Text, style, origin, fonts);
      if (t) ordered.push({ node: t, z: 0, seq: seq++ });
    }
  }
  // ::after paints above content.
  const after = makePseudo(el, '::after', rect, origin, fonts);
  if (after) ordered.push({ node: after, z: zIndexOf(win.getComputedStyle(el, '::after')), seq: seq++ });
  // Stable sort by z-index so positioned/overlapping elements stack correctly.
  ordered.sort((a, b) => a.z - b.z || a.seq - b.seq);
  const children = ordered.map((o) => o.node);

  const frame: FrameLayer = {
    type: 'FRAME',
    name: el.id || tag,
    ...base,
    fills: backgroundPaints(style, baseUrl),
    autoLayout: detectAutoLayout(style),
    children,
  };
  return frame;
}

/**
 * Render `html` in an offscreen iframe at `viewportWidth`, walk it, and return
 * the tree plus the fonts encountered. Using a real document means <head> CSS,
 * <body> backgrounds, @font-face and width-dependent layout all behave exactly
 * as in a browser — the key to high-fidelity conversion.
 */
export async function htmlToLayerTree(
  html: string,
  viewportWidth = FALLBACK_SIZE,
  importImages = true,
  baseUrl?: string,
): Promise<RenderResult> {
  if (!html || !html.trim()) throw new Error('No HTML to import — the source is empty.');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // Give the frame a real, generous size so the document always lays out (a
  // 0/10px-tall frame can leave the body measuring zero inside Figma's plugin
  // iframe, which the offscreen position alone doesn't trigger).
  iframe.style.cssText =
    `position:fixed;left:-99999px;top:0;border:0;background:#fff;width:${viewportWidth}px;height:2000px;`;
  document.body.appendChild(iframe);

  const idoc = iframe.contentDocument;
  const iwin = iframe.contentWindow as (Window & typeof globalThis) | null;
  if (!idoc || !iwin) {
    iframe.remove();
    throw new Error('Could not create a render frame.');
  }

  // If the source is a fragment (no <html>), wrap it in a minimal document.
  const isDocument = /<html[\s>]|<!doctype/i.test(html);
  const fullHtml = isDocument
    ? html
    : `<!doctype html><html><head><meta charset="utf-8">${
        baseUrl ? `<base href="${baseUrl}">` : ''
      }</head><body>${html}</body></html>`;

  idoc.open();
  idoc.write(fullHtml);
  idoc.close();

  // setTimeout (not requestAnimationFrame): an offscreen iframe's rAF is
  // throttled/suspended by the browser and may never fire. Layout itself is
  // forced synchronously whenever we read getBoundingClientRect below.
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const prevWin = win;
  const prevDoc = doc;
  win = iwin;
  doc = idoc;
  try {
    // Let the parser and first layout pass complete.
    await delay(50);

    // Settle: many exports render their UI with JavaScript (React apps, in-browser
    // bundlers with a loading thumbnail, etc.). Poll until any loading overlay is
    // gone and the content height stops changing — or a safety timeout elapses.
    let lastH = -1;
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      const loading =
        idoc.querySelector('#__bundler_thumbnail, #__bundler_loading, .__loading') ||
        sameOriginFrameDocs(idoc).some((d) => d.readyState !== 'complete');
      const h = idoc.documentElement.scrollHeight;
      if (loading) {
        stable = 0;
        lastH = h;
      } else if (h === lastH && h > 0) {
        if (++stable >= 2) break; // height held steady → rendered
      } else {
        stable = 0;
        lastH = h;
      }
      await delay(150);
    }

    // Strip leftover bundler scaffolding so it doesn't become stray layers.
    idoc
      .querySelectorAll('#__bundler_thumbnail, #__bundler_loading, #__bundler_err, #__bundler_placeholder')
      .forEach((el) => el.remove());

    // Many exports center the artwork on a full-viewport backdrop
    // (body { min-height:100vh; display:flex; align-items:center }). Neutralise
    // the vertical fill so the captured frame hugs the content instead of
    // inheriting a tall empty band.
    try {
      idoc.body.style.minHeight = '0px';
      idoc.body.style.height = 'auto';
    } catch {
      /* ignore */
    }
    await delay(16);

    // Wait for fonts and images to settle so geometry is correct.
    const docs = [idoc, ...sameOriginFrameDocs(idoc)];
    try {
      const ready = docs.map((d) => (d as Document & { fonts?: FontFaceSet }).fonts?.ready).filter(Boolean);
      if (ready.length) await Promise.race([Promise.all(ready), delay(2000)]);
    } catch {
      /* fonts API unavailable — proceed */
    }
    const imgs = docs.flatMap((d) => Array.from(d.querySelectorAll('img')));
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) return resolve();
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
            setTimeout(resolve, 3000);
          }),
      ),
    );

    // Size the frame to the content so nothing is clipped, then settle layout.
    const contentH = Math.max(
      idoc.documentElement.scrollHeight,
      idoc.body ? idoc.body.scrollHeight : 0,
      10,
    );
    iframe.style.height = `${contentH}px`;
    await delay(16);

    // Prefer <body>; fall back to <html> if the body measured empty.
    const bodyRect = idoc.body?.getBoundingClientRect();
    let root: HTMLElement =
      idoc.body && bodyRect && bodyRect.width > 0.5 && bodyRect.height > 0.5
        ? idoc.body
        : idoc.documentElement;

    const fonts = new Set<string>();
    let origin = root.getBoundingClientRect();

    // Full-screen overlay / modal exports put every visible box in
    // `position:fixed`/`absolute`, so the body's own content box collapses to
    // zero once we neutralise `min-height:100vh` above. Don't give up: pick a
    // realistic viewport so inset:0 layers size sensibly, stretch the body to
    // cover all visible content, then re-measure from the body.
    if (idoc.body && (origin.width < 0.5 || origin.height < 0.5)) {
      const vw = Math.round(iframe.getBoundingClientRect().width) || viewportWidth;
      const vh = Math.min(2000, Math.max(640, Math.round(vw / 1.6)));
      iframe.style.height = `${vh}px`;
      await delay(16);
      const union = visibleUnion(idoc.body);
      if (union) {
        const fullH = Math.min(8000, Math.max(Math.ceil(union.bottom), vh));
        idoc.body.style.height = `${fullH}px`;
        idoc.body.style.minHeight = `${fullH}px`;
        iframe.style.height = `${fullH}px`;
        await delay(16);
        root = idoc.body;
        origin = root.getBoundingClientRect();
      }
    }

    if (origin.width < 0.5 || origin.height < 0.5) {
      throw new Error(
        `Nothing visible to import (rendered ${Math.round(origin.width)}×${Math.round(
          origin.height,
        )}). Check the HTML has visible content.`,
      );
    }
    const tree = walk(root, origin, fonts, importImages, baseUrl);
    if (!tree) throw new Error('Nothing visible to import.');
    tree.name = 'Imported';
    if (importImages) await resolveImages(tree);
    return { tree, fonts: Array.from(fonts) };
  } finally {
    win = prevWin;
    doc = prevDoc;
    iframe.remove();
  }
}

/**
 * Fetch & decode the bytes of every IMAGE paint (from <img> or background-image)
 * in the iframe, where `fetch` works. Cached per-URL so a sprite reused across
 * many elements is only downloaded once. Failed fetches drop the paint.
 */
async function resolveImages(node: LayerNode): Promise<void> {
  const cache = new Map<string, Promise<Uint8Array | null>>();
  const tasks: Promise<void>[] = [];

  const resolveFills = (layer: LayerNode) => {
    if (!layer.fills) return;
    for (const paint of layer.fills) {
      if (paint.type !== 'IMAGE' || !paint.src || paint.bytes.length) continue;
      const src = paint.src;
      if (!cache.has(src)) cache.set(src, loadImageBytes(src));
      tasks.push(
        cache.get(src)!.then((bytes) => {
          if (bytes) paint.bytes = bytes;
        }),
      );
    }
  };

  const visit = (n: LayerNode) => {
    resolveFills(n);
    if (n.type === 'FRAME') n.children.forEach(visit);
  };
  visit(node);
  await Promise.all(tasks);

  // Drop image paints that never resolved so they don't error in the sandbox.
  const prune = (n: LayerNode) => {
    if (n.fills) n.fills = n.fills.filter((p) => p.type !== 'IMAGE' || p.bytes.length > 0);
    if (n.type === 'FRAME') n.children.forEach(prune);
  };
  prune(node);
}

/** PNG/JPEG/GIF/WebP magic-byte sniff — formats `figma.createImage` accepts as-is. */
function isRasterFigmaImage(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  if (b[0] === 0x89 && b[1] === 0x50) return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8) return true; // JPEG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // RIFF/WebP
  return false;
}

/** Draw any loadable image (incl. SVG) onto a canvas and read PNG bytes. */
function rasterizeToPng(src: string, fallbackW = 512, fallbackH = 512): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || fallbackW;
      const h = img.naturalHeight || fallbackH;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      try {
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null);
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(() => resolve(null));
        }, 'image/png');
      } catch {
        resolve(null); // canvas tainted (cross-origin without CORS)
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Resolve image bytes ready for `figma.createImage`. Raster formats are used
 * directly; SVG (incl. data URIs) and anything else is rasterised to PNG, since
 * the Figma API only ingests PNG/JPEG/GIF.
 */
async function loadImageBytes(src: string): Promise<Uint8Array | null> {
  const isSvg = /^data:image\/svg/i.test(src) || /\.svg(\?|$)/i.test(src);
  if (isSvg) return svgToPng(src);
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isRasterFigmaImage(bytes)) return bytes;
    }
  } catch {
    /* fall through to rasterise via an <img> tag */
  }
  return rasterizeToPng(src);
}

/**
 * Rasterise an SVG (data URI or .svg URL) to PNG via a Blob URL. Loading an SVG
 * data URI straight into an <img> is unreliable when it contains raw `<`, `"`,
 * spaces or literal `%` (e.g. `60%`); a typed Blob avoids all of that. Only
 * valid `%XX` escapes are decoded so `url(%23id)` references still resolve.
 */
async function svgToPng(src: string): Promise<Uint8Array | null> {
  let svgText = '';
  let w = 512;
  let h = 512;
  try {
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      const meta = src.slice(0, comma);
      const data = src.slice(comma + 1);
      svgText = /;base64/i.test(meta)
        ? atob(data)
        : data.replace(/%[0-9A-Fa-f]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
    } else {
      svgText = await (await fetch(src, { mode: 'cors' })).text();
    }
    // Honour the SVG's own width/height so it rasterises at full resolution.
    const wm = svgText.match(/\bwidth=["']?([\d.]+)/i);
    const hm = svgText.match(/\bheight=["']?([\d.]+)/i);
    if (wm) w = parseFloat(wm[1]);
    if (hm) h = parseFloat(hm[1]);
  } catch {
    return null;
  }
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    return await rasterizeToPng(url, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}
