/**
 * ExportNode → El: decides the tag, attributes and CSS declarations of every
 * element for one root frame. Output formats (HTML/CSS, Tailwind, React) and
 * breakpoint merging all work on this intermediate tree.
 */
import type {
  ExportFrame,
  ExportNode,
  ExportOptions,
  ExportPaint,
  ExportText,
  ExportWarning,
  TextRun,
} from '../shared/export';
import type { Decls, Units } from './css';
import { blendMode, cssColor, num, sides, slugify, tokenColor } from './css';
import { backgroundCss, firstColor, gradientCss } from './paint';
import type { FontUsage } from './fonts';
import { fontStack, recordFont } from './fonts';

export type ElKind = 'FRAME' | 'TEXT' | 'SVG' | 'IMG' | 'SPAN' | 'TEXTNODE';

export interface El {
  kind: ElKind;
  /** Source node (absent for spans / text nodes). */
  node?: ExportNode;
  tag: string;
  /** Class-name stem (already slugified). */
  name: string;
  decls: Decls;
  attrs: Record<string, string>;
  /** Plain text content (TEXTNODE, or an element with a single text run). */
  text?: string;
  /** Raw SVG markup (kind SVG). */
  raw?: string;
  children: El[];
  /** Content signature: elements only merge across breakpoints if equal. */
  sig: string;
}

export interface BuildContext {
  opts: ExportOptions;
  units: Units;
  /** URL for an asset; `hi` asks for the high-density copy. */
  assetUrl: (id: string, hi?: boolean) => string;
  /** srcset for an asset with a hi-dpi copy (files mode only). */
  assetSrcset: (id: string) => string | undefined;
  fonts: FontUsage;
  warnings: ExportWarning[];
}

const DEFAULT_NAME = /^(frame|group|rectangle|ellipse|vector|image|img|photo|line|polygon|star|union|subtract|intersect|exclude|component|instance|section)\s*\d*$/i;
const TAG_NAMES = /^(h[1-6]|p|button|a|nav|header|footer|main|section|article|aside|ul|ol|li|label|figure|form)$/i;

function warn(ctx: BuildContext, node: ExportNode | undefined, message: string): void {
  if (ctx.warnings.some((w) => w.message === message && w.nodeId === node?.id)) return;
  ctx.warnings.push({ nodeId: node?.id, nodeName: node?.name, message });
}

function classStem(node: ExportNode, ctx: BuildContext): string {
  const full = slugify(node.name);
  const max = node.kind === 'TEXT' ? 24 : 40;
  // Cut long names (text layers are named after their content) at a word boundary.
  let s = full.length > max ? full.slice(0, max + 1).replace(/-[^-]*$/, '') || full.slice(0, max) : full;
  if (!s) s = node.kind === 'TEXT' ? 'text' : 'el';
  if (/^[0-9]/.test(s)) s = `n-${s}`;
  return ctx.opts.classPrefix + s;
}

interface Scope {
  /** Inside a <button> or <a>: no nested interactive elements. */
  interactive: boolean;
  /** Parent tag (for li validity). */
  parentTag: string;
}

function pickTag(node: ExportNode, ctx: BuildContext, scope: Scope, fallback: string): string {
  if (!ctx.opts.semanticTags) return fallback;
  const name = node.name.trim();
  const m = TAG_NAMES.exec(name);
  let tag: string | undefined = m ? m[1].toLowerCase() : undefined;
  if (!tag && node.kind === 'FRAME') {
    if (/\b(button|btn|cta)\b/i.test(name)) tag = 'button';
    else if (/^(nav|navbar|navigation)\b/i.test(name)) tag = 'nav';
    else if (/^header\b/i.test(name)) tag = 'header';
    else if (/^footer\b/i.test(name)) tag = 'footer';
  }
  if (!tag) return fallback;
  if ((tag === 'button' || tag === 'a') && scope.interactive) return fallback;
  if (tag === 'li' && scope.parentTag !== 'ul' && scope.parentTag !== 'ol') return fallback;
  if (node.kind === 'TEXT' && !/^(h[1-6]|p|a|label|li|button)$/.test(tag)) return fallback;
  return tag;
}

/* ---------------- geometry ---------------- */

function isHug(node: ExportNode, axis: 'H' | 'V'): boolean {
  if (node.kind === 'TEXT') {
    if (node.autoResize === 'WIDTH_AND_HEIGHT') return true;
    if (node.autoResize === 'HEIGHT') return axis === 'V';
    return false;
  }
  return (axis === 'H' ? node.sizingH : node.sizingV) === 'HUG' && node.kind === 'FRAME' && !!node.layout;
}

function rootDecls(node: ExportNode, ctx: BuildContext, d: Decls): void {
  const u = ctx.units;
  d.position = 'relative';
  if (u.layout === 'fluid') {
    d.width = '100%';
    if (!isHug(node, 'H')) d['max-width'] = `${num(node.width)}px`;
    d.margin = '0 auto';
    if (!isHug(node, 'V')) d['min-height'] = u.len(node.height);
  } else {
    if (!isHug(node, 'H')) d.width = u.len(node.width);
    if (!isHug(node, 'V')) d[node.kind === 'FRAME' && node.layout ? 'min-height' : 'height'] = u.len(node.height);
  }
}

function absoluteDecls(node: ExportNode, parent: ExportFrame, ctx: BuildContext, d: Decls): void {
  const u = ctx.units;
  d.position = 'absolute';
  const w = !isHug(node, 'H');
  const h = !isHug(node, 'V');
  if (node.matrix || u.layout !== 'fluid') {
    d.left = u.len(node.x);
    d.top = u.len(node.y);
    if (w) d.width = u.len(node.width);
    if (h) d.height = u.len(node.height);
    if (node.matrix) {
      d.transform = `matrix(${node.matrix.map((v) => num(v, 4)).join(', ')}, 0, 0)`;
      d['transform-origin'] = '0 0';
    }
    return;
  }
  axis(node.constraints.h, node.x, node.width, parent.width, 'left', 'right', 'width', w);
  axis(node.constraints.v, node.y, node.height, parent.height, 'top', 'bottom', 'height', h);

  function axis(c: string, pos: number, size: number, total: number, start: string, end: string, dim: string, sized: boolean) {
    const tail = total - pos - size;
    switch (c) {
      case 'MAX':
        d[end] = u.len(tail);
        if (sized) d[dim] = u.len(size);
        break;
      case 'STRETCH':
        d[start] = u.len(pos);
        d[end] = u.len(tail);
        break;
      case 'CENTER': {
        const off = pos - total / 2;
        d[start] = off ? `calc(50% ${off < 0 ? '-' : '+'} ${u.len(Math.abs(off))})` : '50%';
        if (sized) d[dim] = u.len(size);
        break;
      }
      case 'SCALE':
        d[start] = `${num((pos / (total || 1)) * 100)}%`;
        if (sized) d[dim] = `${num((size / (total || 1)) * 100)}%`;
        break;
      default:
        d[start] = u.len(pos);
        if (sized) d[dim] = u.len(size);
    }
  }
}

function flowDecls(node: ExportNode, parent: ExportFrame, ctx: BuildContext, d: Decls): void {
  const u = ctx.units;
  const row = parent.layout!.direction === 'ROW';
  const fixedMode = u.layout !== 'fluid';
  const [mainSize, crossSize] = row ? ['width', 'height'] : ['height', 'width'];
  const [mainSizing, crossSizing] = row ? [node.sizingH, node.sizingV] : [node.sizingV, node.sizingH];
  const [mainPx, crossPx] = row ? [node.width, node.height] : [node.height, node.width];
  const mainHug = isHug(node, row ? 'H' : 'V');
  const crossHug = isHug(node, row ? 'V' : 'H');

  if (mainSizing === 'FILL') {
    d.flex = '1 1 0';
    d[row ? 'min-width' : 'min-height'] = '0';
  } else {
    if (mainSizing === 'FIXED' && !mainHug) d[mainSize] = u.len(mainPx);
    if (fixedMode) d['flex-shrink'] = '0';
  }
  if (crossSizing === 'FILL') d['align-self'] = 'stretch';
  else if (crossSizing === 'FIXED' && !crossHug) {
    d[crossSize] = u.len(crossPx);
    if (!fixedMode && !row) d['max-width'] = '100%';
  }
  if (node.matrix) {
    d.transform = `matrix(${node.matrix.map((v) => num(v, 4)).join(', ')}, 0, 0)`;
    warn(ctx, node, 'Rotated layer inside auto layout: rotation is approximate.');
  }
}

function limits(node: ExportNode, ctx: BuildContext, d: Decls): void {
  const u = ctx.units;
  if (node.minWidth != null) d['min-width'] = u.len(node.minWidth);
  if (node.maxWidth != null) d['max-width'] = u.len(node.maxWidth);
  if (node.minHeight != null) d['min-height'] = u.len(node.minHeight);
  if (node.maxHeight != null) d['max-height'] = u.len(node.maxHeight);
}

/* ---------------- visuals ---------------- */

function spacing(ctx: BuildContext, px: number, variable?: string): string {
  const v = ctx.units.len(px);
  return ctx.opts.useVariables && variable ? `var(--${variable}, ${v})` : v;
}

function autoLayoutDecls(frame: ExportFrame, ctx: BuildContext, d: Decls): void {
  const l = frame.layout!;
  const vars = l.variables ?? {};
  d.display = 'flex';
  if (l.direction === 'COLUMN') d['flex-direction'] = 'column';
  if (l.wrap) d['flex-wrap'] = 'wrap';
  const main = l.justify === 'SPACE_BETWEEN' ? '' : l.gap ? spacing(ctx, l.gap, vars.gap) : '';
  const cross = l.wrap && l.crossGap ? spacing(ctx, l.crossGap, vars.crossGap) : '';
  if (main && cross) d.gap = l.direction === 'ROW' ? `${cross} ${main}` : `${main} ${cross}`;
  else if (main) d.gap = main;
  else if (cross) d[l.direction === 'ROW' ? 'row-gap' : 'column-gap'] = cross;
  if (l.padding.some((p) => p)) {
    d.padding = sides([
      spacing(ctx, l.padding[0], vars.paddingTop),
      spacing(ctx, l.padding[1], vars.paddingRight),
      spacing(ctx, l.padding[2], vars.paddingBottom),
      spacing(ctx, l.padding[3], vars.paddingLeft),
    ]);
  }
  const justify = { MIN: '', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }[l.justify];
  if (justify) d['justify-content'] = justify;
  d['align-items'] = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[l.align];
}

function strokeDecls(node: ExportNode, ctx: BuildContext, d: Decls, shadows: string[]): void {
  const s = node.stroke;
  if (!s) return;
  const u = ctx.units;
  const color = firstColor(s.paints, ctx.opts.useVariables) ?? '#000';
  if (s.paints.some((p) => p.type !== 'SOLID')) warn(ctx, node, 'Gradient/image stroke approximated with a solid colour.');
  const [t, r, b, l] = s.weights;
  if (node.kind === 'TEXT') {
    d['-webkit-text-stroke'] = `${u.line(t)} ${color}`;
    return;
  }
  if (t === r && r === b && b === l) {
    d.outline = `${u.line(t)} ${s.dashed ? 'dashed' : 'solid'} ${color}`;
    const off = s.align === 'INSIDE' ? -t : s.align === 'CENTER' ? -t / 2 : 0;
    if (off) d['outline-offset'] = u.line(off);
    return;
  }
  if (s.dashed) {
    d['border-style'] = 'dashed';
    d['border-width'] = sides([u.line(t), u.line(r), u.line(b), u.line(l)]);
    d['border-color'] = color;
    return;
  }
  if (t) shadows.push(`inset 0 ${u.line(t)} 0 0 ${color}`);
  if (r) shadows.push(`inset ${u.line(-r)} 0 0 0 ${color}`);
  if (b) shadows.push(`inset 0 ${u.line(-b)} 0 0 ${color}`);
  if (l) shadows.push(`inset ${u.line(l)} 0 0 0 ${color}`);
}

function effectDecls(node: ExportNode, ctx: BuildContext, d: Decls, shadows: string[]): void {
  const u = ctx.units;
  const isText = node.kind === 'TEXT';
  const textShadows: string[] = [];
  const filters: string[] = [];
  for (const e of [...node.effects].reverse()) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const c = cssColor(e.color);
      if (isText) {
        if (e.type === 'INNER_SHADOW') warn(ctx, node, 'Inner shadow on text is not supported.');
        else textShadows.push(`${u.line(e.x)} ${u.line(e.y)} ${u.line(e.blur)} ${c}`);
        continue;
      }
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      const spread = e.spread ? ` ${u.line(e.spread)}` : '';
      shadows.push(`${inset}${u.line(e.x)} ${u.line(e.y)} ${u.line(e.blur)}${spread} ${c}`);
    } else if (e.type === 'LAYER_BLUR') {
      filters.push(`blur(${u.line(e.radius / 2)})`);
    } else if (e.type === 'BACKGROUND_BLUR') {
      d['backdrop-filter'] = `blur(${u.line(e.radius / 2)})`;
      d['-webkit-backdrop-filter'] = d['backdrop-filter'];
    }
  }
  if (textShadows.length) d['text-shadow'] = textShadows.join(', ');
  if (filters.length) d.filter = filters.join(' ');
}

function boxVisuals(node: ExportNode, ctx: BuildContext, d: Decls, withFills: boolean): void {
  const u = ctx.units;
  if (withFills && node.kind !== 'TEXT') {
    const bg = backgroundCss(node.fills, {
      width: node.width,
      height: node.height,
      useVars: ctx.opts.useVariables,
      assetUrl: (id) => ctx.assetUrl(id, true),
      fluid: u.layout !== 'fixed',
      warn: (m) => warn(ctx, node, m),
    });
    if (bg) d.background = bg;
  }
  if (node.kind === 'FRAME' && node.ellipse) d['border-radius'] = '50%';
  else if (node.radius?.some((r) => r > 0)) d['border-radius'] = sides(node.radius.map((r) => u.len(r)) as [string, string, string, string]);
  const shadows: string[] = [];
  strokeDecls(node, ctx, d, shadows);
  effectDecls(node, ctx, d, shadows);
  if (shadows.length) d['box-shadow'] = shadows.join(', ');
  if (node.opacity < 0.999) d.opacity = num(node.opacity, 3);
  const blend = blendMode(node.blendMode);
  if (blend) d['mix-blend-mode'] = blend;
}

/* ---------------- text ---------------- */

const TEXT_DEFAULTS: Decls = {
  'font-style': 'normal',
  'letter-spacing': 'normal',
  'text-decoration': 'none',
  'text-transform': 'none',
  'font-variant': 'normal',
  'line-height': 'normal',
};

function textPaint(fills: ExportPaint[], node: ExportText, ctx: BuildContext, d: Decls): void {
  const top = fills[fills.length - 1];
  if (!top) {
    d.color = 'transparent';
    return;
  }
  if (top.type === 'SOLID') {
    d.color = tokenColor(top.color, 1, top.variable, ctx.opts.useVariables);
  } else if (top.type === 'IMAGE') {
    warn(ctx, node, 'Image fill on text is not supported; used a flat colour.');
    d.color = firstColor(fills.slice(0, -1), ctx.opts.useVariables) ?? '#000';
  } else {
    d.color = 'transparent';
    d.background = gradientCss(top, node.width, node.height, ctx.opts.useVariables);
    d['-webkit-background-clip'] = 'text';
    d['background-clip'] = 'text';
  }
}

/** Full style of a run, including defaults (so runs can be diffed). */
function runDecls(r: TextRun, node: ExportText, ctx: BuildContext): Decls {
  const u = ctx.units;
  recordFont(ctx.fonts, r.fontFamily, r.fontWeight, r.italic);
  const d: Decls = {
    'font-family': fontStack(r.fontFamily),
    'font-size': u.len(r.fontSize),
    'font-weight': String(r.fontWeight),
    'font-style': r.italic ? 'italic' : 'normal',
    'line-height':
      r.lineHeight.unit === 'AUTO'
        ? 'normal'
        : r.lineHeight.unit === 'PX'
          ? u.len(r.lineHeight.value)
          : num(r.lineHeight.value / 100, 3),
    'letter-spacing': !r.letterSpacing.value
      ? 'normal'
      : r.letterSpacing.unit === 'PX'
        ? u.len(r.letterSpacing.value)
        : `${num(r.letterSpacing.value / 100, 4)}em`,
    'text-decoration': r.decoration === 'UNDERLINE' ? 'underline' : r.decoration === 'STRIKETHROUGH' ? 'line-through' : 'none',
    'text-transform':
      r.textCase === 'UPPER' ? 'uppercase' : r.textCase === 'LOWER' ? 'lowercase' : r.textCase === 'TITLE' ? 'capitalize' : 'none',
    'font-variant': r.textCase === 'SMALL_CAPS' || r.textCase === 'SMALL_CAPS_FORCED' ? 'small-caps' : 'normal',
  };
  textPaint(r.fills, node, ctx, d);
  return d;
}

function dominantRun(node: ExportText): TextRun | undefined {
  let best: TextRun | undefined;
  for (const r of node.runs) if (!best || r.end - r.start > best.end - best.start) best = r;
  return best;
}

function textEl(node: ExportText, ctx: BuildContext, scope: Scope, d: Decls): El {
  const base = dominantRun(node);
  const baseFull = base ? runDecls(base, node, ctx) : {};
  for (const [k, v] of Object.entries(baseFull)) if (TEXT_DEFAULTS[k] !== v) d[k] = v;
  if (node.alignH !== 'LEFT') d['text-align'] = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify', LEFT: 'left' }[node.alignH];

  const noWrap = node.autoResize === 'WIDTH_AND_HEIGHT' && ctx.units.layout !== 'fluid';
  d['white-space'] = noWrap ? 'pre' : 'pre-wrap';

  let inner = false;
  if (node.autoResize === 'TRUNCATE') {
    d.overflow = 'hidden';
    if ((node.maxLines ?? 1) > 1) {
      d.display = '-webkit-box';
      d['-webkit-box-orient'] = 'vertical';
      d['-webkit-line-clamp'] = String(node.maxLines);
    } else {
      d['white-space'] = 'pre';
      d['text-overflow'] = 'ellipsis';
    }
  } else if (node.autoResize === 'NONE' && node.alignV !== 'TOP') {
    d.display = 'flex';
    d['flex-direction'] = 'column';
    d['justify-content'] = node.alignV === 'CENTER' ? 'center' : 'flex-end';
    inner = true;
  }

  const wholeLink = node.runs.length === 1 && node.runs[0].link;
  let tag = pickTag(node, ctx, scope, 'p');
  if (wholeLink && !scope.interactive && ctx.opts.semanticTags) tag = 'a';

  const el: El = {
    kind: 'TEXT',
    node,
    tag,
    name: classStem(node, ctx),
    decls: d,
    attrs: {},
    children: [],
    sig: '',
  };
  if (tag === 'a' && wholeLink) el.attrs.href = wholeLink;

  let content: El[] = [];
  if (node.runs.length <= 1) {
    if (inner) content = [{ kind: 'TEXTNODE', tag: '#text', name: '', decls: {}, attrs: {}, text: node.characters, children: [], sig: '' }];
    else el.text = node.characters;
  } else {
    let i = 0;
    for (const r of node.runs) {
      const full = runDecls(r, node, ctx);
      const diff: Decls = {};
      for (const [k, v] of Object.entries(full)) if (baseFull[k] !== v) diff[k] = v;
      const text = node.characters.slice(r.start, r.end);
      const link = r.link && !scope.interactive && tag !== 'a';
      if (!Object.keys(diff).length && !link) {
        content.push({ kind: 'TEXTNODE', tag: '#text', name: '', decls: {}, attrs: {}, text, children: [], sig: '' });
      } else {
        content.push({
          kind: 'SPAN',
          tag: link ? 'a' : 'span',
          name: `${el.name}-${++i}`,
          decls: diff,
          attrs: link ? { href: r.link! } : {},
          text,
          children: [],
          sig: '',
        });
      }
    }
  }
  if (inner) {
    el.children = [{ kind: 'SPAN', tag: 'span', name: `${el.name}-inner`, decls: {}, attrs: {}, children: content, sig: '' }];
  } else {
    el.children = content;
  }
  el.sig = `T:${node.characters}|${JSON.stringify(content.map((c) => [c.tag, c.decls, c.attrs]))}`;
  return el;
}

/* ---------------- tree ---------------- */

function isImageFrame(node: ExportFrame): Extract<ExportPaint, { type: 'IMAGE' }> | undefined {
  if (node.children.length || node.fills.length !== 1) return undefined;
  const p = node.fills[0];
  return p.type === 'IMAGE' && (p.scaleMode === 'FILL' || p.scaleMode === 'FIT') && p.opacity >= 0.999 ? p : undefined;
}

function altText(node: ExportNode): string {
  return DEFAULT_NAME.test(node.name.trim()) ? '' : node.name.trim();
}

function prepareSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*>\s*/g, '')
    .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
      const kept = attrs.replace(/\s(width|height)="[^"]*"/g, '');
      return `<svg${kept} aria-hidden="true">`;
    })
    .trim();
}

function buildNode(node: ExportNode, parent: ExportFrame | null, ctx: BuildContext, scope: Scope): El {
  const d: Decls = {};
  if (!parent) rootDecls(node, ctx, d);
  else if (node.absolute || !parent.layout) absoluteDecls(node, parent, ctx, d);
  else flowDecls(node, parent, ctx, d);
  limits(node, ctx, d);

  const attrs: Record<string, string> = {};
  if (node.component) attrs['data-component'] = node.component;

  if (node.kind === 'TEXT') {
    const el = textEl(node, ctx, scope, d);
    boxVisuals(node, ctx, d, false);
    Object.assign(el.attrs, attrs);
    return el;
  }

  if (node.kind === 'SVG') {
    boxVisuals(node, ctx, d, false);
    const raw = prepareSvg(node.svg);
    return { kind: 'SVG', node, tag: 'svg', name: classStem(node, ctx), decls: d, attrs, raw, children: [], sig: `S:${raw}` };
  }

  if (node.kind === 'RASTER') {
    boxVisuals(node, ctx, d, false);
    const src = ctx.assetUrl(node.assetId, true);
    const srcset = ctx.assetSrcset(node.assetId);
    Object.assign(attrs, { src, alt: altText(node) });
    if (srcset) attrs.srcset = srcset;
    return { kind: 'IMG', node, tag: 'img', name: classStem(node, ctx), decls: d, attrs, children: [], sig: `R:${node.id}` };
  }

  const img = isImageFrame(node);
  if (img) {
    d['object-fit'] = img.scaleMode === 'FIT' ? 'contain' : 'cover';
    boxVisuals(node, ctx, d, false);
    Object.assign(attrs, { src: ctx.assetUrl(img.assetId, true), alt: altText(node) });
    return { kind: 'IMG', node, tag: 'img', name: classStem(node, ctx), decls: d, attrs, children: [], sig: `I:${img.assetId}` };
  }

  if (node.layout && !(parent && node.matrix && ctx.units.layout === 'fluid')) autoLayoutDecls(node, ctx, d);
  if (!d.position && node.children.some((c) => c.absolute || !node.layout)) d.position = 'relative';
  if (node.scroll) {
    if (node.scroll === 'HORIZONTAL') d['overflow-x'] = 'auto';
    else if (node.scroll === 'VERTICAL') d['overflow-y'] = 'auto';
    else d.overflow = 'auto';
  } else if (node.clips && (node.children.length || node.ellipse)) d.overflow = 'hidden';
  boxVisuals(node, ctx, d, true);

  const tag = pickTag(node, ctx, scope, 'div');
  const childScope: Scope = { interactive: scope.interactive || tag === 'button' || tag === 'a', parentTag: tag };
  const children = node.children.map((c) => buildNode(c, node, ctx, childScope));
  return { kind: 'FRAME', node, tag, name: classStem(node, ctx), decls: d, attrs, children, sig: `F:${tag}` };
}

export function buildRoot(root: ExportNode, ctx: BuildContext): El {
  return buildNode(root, null, ctx, { interactive: false, parentTag: '' });
}
