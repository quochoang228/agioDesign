/**
 * Figma → ExportNode serialiser (sandbox side). Walks the selected nodes and
 * produces the plain tree the code generator consumes, exporting SVG markup for
 * vectors/icons and bytes for images and flattened nodes along the way.
 *
 * Positions come from absolute transforms (inverse(parent) · child) rather than
 * `x/y`, because children of groups report coordinates relative to the nearest
 * frame, not the group, and rotation must be split out explicitly.
 */
import type {
  AutoLayout,
  ColorStop,
  Constraint,
  ExportAsset,
  ExportBundle,
  ExportEffect,
  ExportFrame,
  ExportNode,
  ExportNodeBase,
  ExportPaint,
  ExportStroke,
  ExportText,
  ExportWarning,
  RGBA,
  Sizing,
  TextRun,
  Transform2D,
} from '../../shared/export';
import { cssColor, slugify } from '../../codegen/css';

export interface SerializeOptions {
  /** Pixel density for flattened (raster) nodes. */
  density: 1 | 2 | 3;
  /** Also export a 1× copy so the generator can emit a srcset. */
  srcset: boolean;
  onProgress?: (done: number) => void;
}

type M = Transform2D;

const VECTORISH = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'POLYGON']);
const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION']);
const ICON_MAX = 64;

function invert(m: M): M {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
}

function multiply(p: M, q: M): M {
  return [
    [p[0][0] * q[0][0] + p[0][1] * q[1][0], p[0][0] * q[0][1] + p[0][1] * q[1][1], p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2]],
    [p[1][0] * q[0][0] + p[1][1] * q[1][0], p[1][0] * q[0][1] + p[1][1] * q[1][1], p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2]],
  ];
}

const round = (n: number, p = 100) => Math.round(n * p) / p;

/** Sniff an image's mime type from its magic bytes. */
function sniffMime(b: Uint8Array): { mime: string; ext: string } {
  if (b[0] === 0x89 && b[1] === 0x50) return { mime: 'image/png', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x47 && b[1] === 0x49) return { mime: 'image/gif', ext: 'gif' };
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/png', ext: 'png' };
}

class Serializer {
  assets = new Map<string, ExportAsset>();
  warnings: ExportWarning[] = [];
  variables: Record<string, string> = {};
  private varNames = new Map<string, string | null>();
  private assetNames = new Map<string, number>();
  private warned = new Set<string>();
  private done = 0;

  constructor(private opts: SerializeOptions) {}

  warn(node: SceneNode | null, message: string): void {
    const key = (node?.id ?? '') + message;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push({ nodeId: node?.id, nodeName: node?.name, message });
  }

  private uniqueAssetName(base: string): string {
    const stem = slugify(base) || 'image';
    const n = (this.assetNames.get(stem) ?? 0) + 1;
    this.assetNames.set(stem, n);
    return n === 1 ? stem : `${stem}-${n}`;
  }

  private async variableName(id: string | undefined, value: string): Promise<string | undefined> {
    if (!id) return undefined;
    if (!this.varNames.has(id)) {
      let name: string | null = null;
      try {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) name = slugify(v.name.replace(/\//g, '-'));
      } catch {
        /* remote/unavailable variable */
      }
      this.varNames.set(id, name);
    }
    const name = this.varNames.get(id) ?? undefined;
    if (name && !(name in this.variables)) this.variables[name] = value;
    return name;
  }

  private async imageAsset(hash: string, nodeName: string): Promise<string | null> {
    if (this.assets.has(hash)) return hash;
    const img = figma.getImageByHash(hash);
    if (!img) return null;
    const bytes = await img.getBytesAsync();
    const { mime } = sniffMime(bytes);
    this.assets.set(hash, { id: hash, name: this.uniqueAssetName(nodeName), mime, bytes });
    return hash;
  }

  async rasterAsset(node: SceneNode): Promise<string> {
    const { density, srcset } = this.opts;
    const hi = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: density } });
    const asset: ExportAsset = { id: `raster:${node.id}`, name: this.uniqueAssetName(node.name), mime: 'image/png', bytes: hi };
    if (srcset && density > 1) {
      asset.bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      asset.hiDpi = { scale: density, bytes: hi };
    }
    this.assets.set(asset.id, asset);
    return asset.id;
  }

  async paints(list: ReadonlyArray<Paint> | PluginAPI['mixed'] | undefined, node: SceneNode): Promise<ExportPaint[]> {
    if (!list || list === figma.mixed) return [];
    const out: ExportPaint[] = [];
    for (const p of list as ReadonlyArray<Paint>) {
      if (p.visible === false) continue;
      const opacity = p.opacity ?? 1;
      if (p.type === 'SOLID') {
        const color: RGBA = { ...p.color, a: opacity };
        const variable = await this.variableName(p.boundVariables?.color?.id, cssColor({ ...p.color, a: 1 }));
        out.push(variable ? { type: 'SOLID', color, variable } : { type: 'SOLID', color });
      } else if (
        p.type === 'GRADIENT_LINEAR' ||
        p.type === 'GRADIENT_RADIAL' ||
        p.type === 'GRADIENT_ANGULAR' ||
        p.type === 'GRADIENT_DIAMOND'
      ) {
        const stops: ColorStop[] = [];
        for (const s of p.gradientStops) {
          const variable = await this.variableName(s.boundVariables?.color?.id, cssColor({ ...s.color, a: 1 }));
          stops.push(variable ? { position: s.position, color: s.color, variable } : { position: s.position, color: s.color });
        }
        if (p.type === 'GRADIENT_DIAMOND') this.warn(node, 'Diamond gradient approximated as radial.');
        out.push({ type: p.type, stops, transform: p.gradientTransform as M, opacity });
      } else if (p.type === 'IMAGE') {
        if (!p.imageHash) continue;
        const assetId = await this.imageAsset(p.imageHash, node.name);
        if (!assetId) continue;
        out.push({
          type: 'IMAGE',
          assetId,
          scaleMode: p.scaleMode,
          imageTransform: p.scaleMode === 'CROP' ? (p.imageTransform as M | undefined) : undefined,
          scalingFactor: p.scalingFactor,
          opacity,
        });
      } else {
        this.warn(node, `${p.type} fill is not supported and was skipped.`);
      }
    }
    return out;
  }

  async stroke(node: SceneNode): Promise<ExportStroke | undefined> {
    if (!('strokes' in node) || !node.strokes.length) return undefined;
    const paints = await this.paints(node.strokes, node);
    if (!paints.length) return undefined;
    const g = node as SceneNode & IndividualStrokesMixin & MinimalStrokesMixin;
    const w = g.strokeWeight;
    const weights: [number, number, number, number] =
      w === figma.mixed || 'strokeTopWeight' in g
        ? [g.strokeTopWeight ?? 0, g.strokeRightWeight ?? 0, g.strokeBottomWeight ?? 0, g.strokeLeftWeight ?? 0]
        : [w as number, w as number, w as number, w as number];
    if (weights.every((x) => !x)) return undefined;
    const dash = 'dashPattern' in g ? (g as GeometryMixin & { dashPattern: ReadonlyArray<number> }).dashPattern : [];
    return { paints, weights, align: g.strokeAlign, dashed: !!dash && dash.length > 0 };
  }

  effects(node: SceneNode): ExportEffect[] {
    if (!('effects' in node)) return [];
    const out: ExportEffect[] = [];
    for (const e of node.effects) {
      if (!e.visible) continue;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        out.push({
          type: e.type,
          color: e.color,
          x: e.offset.x,
          y: e.offset.y,
          blur: e.radius,
          spread: e.spread ?? 0,
        });
      } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
        out.push({ type: e.type, radius: e.radius });
      } else {
        this.warn(node, `${(e as Effect).type} effect is not supported and was skipped.`);
      }
    }
    return out;
  }

  radius(node: SceneNode): [number, number, number, number] | undefined {
    if (!('cornerRadius' in node)) return undefined;
    const n = node as SceneNode & CornerMixin & Partial<RectangleCornerMixin>;
    const r =
      n.cornerRadius === figma.mixed
        ? [n.topLeftRadius ?? 0, n.topRightRadius ?? 0, n.bottomRightRadius ?? 0, n.bottomLeftRadius ?? 0]
        : [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
    return r.some((x) => x > 0) ? (r.map((x) => round(x)) as [number, number, number, number]) : undefined;
  }

  async base(node: SceneNode, parent: SceneNode | null): Promise<Omit<ExportNodeBase, 'fills'> & { fills: ExportPaint[] }> {
    const n = node as SceneNode & LayoutMixin & BlendMixin;
    let x = 0;
    let y = 0;
    let matrix: ExportNodeBase['matrix'];
    if (parent) {
      const rel = multiply(invert(parent.absoluteTransform as M), n.absoluteTransform as M);
      const [[a, c, e], [b, d, f]] = rel;
      x = round(e);
      y = round(f);
      if (Math.abs(a - 1) > 1e-4 || Math.abs(d - 1) > 1e-4 || Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) {
        matrix = [round(a, 1e4), round(b, 1e4), round(c, 1e4), round(d, 1e4)];
      }
    }

    const p = parent as (SceneNode & AutoLayoutMixin) | null;
    const parentFlow = !!p && 'layoutMode' in p && (p.layoutMode === 'HORIZONTAL' || p.layoutMode === 'VERTICAL');
    const absolute = !parentFlow || ('layoutPositioning' in n && n.layoutPositioning === 'ABSOLUTE');
    if (p && 'layoutMode' in p && p.layoutMode === 'GRID') this.warn(p, 'Grid auto layout exported with absolute positions.');

    const sizing = (axis: 'layoutSizingHorizontal' | 'layoutSizingVertical'): Sizing => {
      try {
        return ((n as unknown as Record<string, Sizing>)[axis] as Sizing) ?? 'FIXED';
      } catch {
        return 'FIXED';
      }
    };
    const cons = 'constraints' in n ? (n as ConstraintMixin).constraints : undefined;
    const lim = n as SceneNode & Partial<Record<'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', number | null>>;

    const out: Omit<ExportNodeBase, 'fills'> & { fills: ExportPaint[] } = {
      id: node.id,
      name: node.name,
      x,
      y,
      width: round(n.width),
      height: round(n.height),
      opacity: 'opacity' in n ? round(n.opacity, 1000) : 1,
      absolute,
      sizingH: sizing('layoutSizingHorizontal'),
      sizingV: sizing('layoutSizingVertical'),
      constraints: { h: (cons?.horizontal ?? 'MIN') as Constraint, v: (cons?.vertical ?? 'MIN') as Constraint },
      fills: 'fills' in node ? await this.paints((node as GeometryMixin).fills, node) : [],
      effects: this.effects(node),
    };
    if (matrix) out.matrix = matrix;
    if ('blendMode' in n && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH') out.blendMode = n.blendMode;
    for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const v = lim[k];
      if (typeof v === 'number') out[k] = v;
    }
    const stroke = await this.stroke(node);
    if (stroke) out.stroke = stroke;
    const radius = this.radius(node);
    if (radius) out.radius = radius;
    if (node.type === 'INSTANCE') {
      try {
        const main = await node.getMainComponentAsync();
        if (main) out.component = main.parent?.type === 'COMPONENT_SET' ? main.parent.name : main.name;
      } catch {
        /* remote component */
      }
    } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      out.component = node.parent?.type === 'COMPONENT_SET' ? node.parent.name : node.name;
    }
    return out;
  }

  private async autoLayout(node: SceneNode): Promise<AutoLayout | undefined> {
    if (!('layoutMode' in node)) return undefined;
    const f = node as SceneNode & AutoLayoutMixin & Partial<AutoLayoutChildrenMixin>;
    if (f.layoutMode !== 'HORIZONTAL' && f.layoutMode !== 'VERTICAL') return undefined;
    const layout: AutoLayout = {
      direction: f.layoutMode === 'HORIZONTAL' ? 'ROW' : 'COLUMN',
      wrap: f.layoutWrap === 'WRAP',
      gap: f.itemSpacing,
      crossGap: f.counterAxisSpacing ?? f.itemSpacing,
      padding: [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft],
      justify: f.primaryAxisAlignItems,
      align: f.counterAxisAlignItems,
    };
    const bound = (f as SceneNode & { boundVariables?: Record<string, VariableAlias | undefined> }).boundVariables;
    if (bound) {
      const map = {
        gap: 'itemSpacing',
        crossGap: 'counterAxisSpacing',
        paddingTop: 'paddingTop',
        paddingRight: 'paddingRight',
        paddingBottom: 'paddingBottom',
        paddingLeft: 'paddingLeft',
      } as const;
      const values: Record<keyof typeof map, number> = {
        gap: layout.gap,
        crossGap: layout.crossGap,
        paddingTop: layout.padding[0],
        paddingRight: layout.padding[1],
        paddingBottom: layout.padding[2],
        paddingLeft: layout.padding[3],
      };
      for (const key of Object.keys(map) as (keyof typeof map)[]) {
        const alias = bound[map[key]];
        const name = await this.variableName(alias?.id, `${values[key]}px`);
        if (name) (layout.variables ??= {})[key] = name;
      }
    }
    return layout;
  }

  private tick(): void {
    this.done++;
    if (this.done % 25 === 0) this.opts.onProgress?.(this.done);
  }

  /** True if the subtree is purely vector shapes (an icon/illustration). */
  private isVectorOnly(node: SceneNode): boolean {
    if (node.type === 'TEXT') return false;
    if ('fills' in node && Array.isArray(node.fills) && (node.fills as Paint[]).some((p) => p.type === 'IMAGE' && p.visible !== false))
      return false;
    if (VECTORISH.has(node.type) || node.type === 'ELLIPSE' || node.type === 'RECTANGLE') return true;
    if ('children' in node && CONTAINERS.has(node.type)) return node.children.every((c) => !c.visible || this.isVectorOnly(c));
    return false;
  }

  private hasMask(node: SceneNode): boolean {
    return 'children' in node && node.children.some((c) => 'isMask' in c && c.isMask && c.visible);
  }

  private async svg(node: SceneNode, parent: SceneNode | null): Promise<ExportNode> {
    let svg = '';
    try {
      svg = await node.exportAsync({ format: 'SVG_STRING', svgIdAttribute: false });
    } catch {
      const bytes = await node.exportAsync({ format: 'SVG' });
      svg = String.fromCharCode(...Array.from(bytes));
    }
    // SVG export bakes rotation in; the wrapper box must be the rotated bounds.
    const base = await this.base(node, parent);
    const box = 'absoluteRenderBounds' in node ? node.absoluteRenderBounds : null;
    if (base.matrix && box && parent) {
      const inv = invert(parent.absoluteTransform as M);
      base.x = round(inv[0][0] * box.x + inv[0][1] * box.y + inv[0][2]);
      base.y = round(inv[1][0] * box.x + inv[1][1] * box.y + inv[1][2]);
      base.width = round(box.width);
      base.height = round(box.height);
      delete base.matrix;
    }
    return { ...base, kind: 'SVG', fills: [], stroke: undefined, effects: [], radius: undefined, svg };
  }

  private async raster(node: SceneNode, parent: SceneNode | null): Promise<ExportNode> {
    const assetId = await this.rasterAsset(node);
    const base = await this.base(node, parent);
    return { ...base, kind: 'RASTER', fills: [], stroke: undefined, effects: [], radius: undefined, assetId };
  }

  private async text(node: TextNode, parent: SceneNode | null): Promise<ExportText> {
    const base = await this.base(node, parent);
    const segs = node.getStyledTextSegments([
      'fontName',
      'fontWeight',
      'fontSize',
      'lineHeight',
      'letterSpacing',
      'fills',
      'textDecoration',
      'textCase',
      'hyperlink',
    ]);
    const runs: TextRun[] = [];
    for (const s of segs) {
      const lh = s.lineHeight;
      const ls = s.letterSpacing;
      runs.push({
        start: s.start,
        end: s.end,
        fontFamily: s.fontName.family,
        fontWeight: s.fontWeight,
        italic: /italic|oblique/i.test(s.fontName.style),
        fontSize: s.fontSize,
        lineHeight:
          lh.unit === 'AUTO'
            ? { unit: 'AUTO', value: 0 }
            : { unit: lh.unit === 'PIXELS' ? 'PX' : 'PERCENT', value: round(lh.value) },
        letterSpacing: { unit: ls.unit === 'PIXELS' ? 'PX' : 'PERCENT', value: round(ls.value) },
        fills: await this.paints(s.fills, node),
        decoration: s.textDecoration,
        textCase: s.textCase,
        link: s.hyperlink && s.hyperlink.type === 'URL' ? s.hyperlink.value : undefined,
      });
    }
    const truncate = node.textTruncation === 'ENDING';
    const out: ExportText = {
      ...base,
      kind: 'TEXT',
      fills: [],
      characters: node.characters,
      runs,
      alignH: node.textAlignHorizontal,
      alignV: node.textAlignVertical,
      autoResize: truncate ? 'TRUNCATE' : node.textAutoResize,
    };
    if (truncate && node.maxLines) out.maxLines = node.maxLines;
    return out;
  }

  async node(node: SceneNode, parent: SceneNode | null): Promise<ExportNode | null> {
    if (!node.visible || node.type === 'SLICE') return null;
    this.tick();

    if (node.type === 'TEXT') return this.text(node, parent);
    if (VECTORISH.has(node.type)) return this.svg(node, parent);

    if (node.type === 'ELLIPSE') {
      const arc = node.arcData;
      const full = arc.innerRadius === 0 && Math.abs(arc.endingAngle - arc.startingAngle - 2 * Math.PI) < 1e-3;
      if (!full) return this.svg(node, parent);
      const base = await this.base(node, parent);
      return { ...base, kind: 'FRAME', ellipse: true, clips: true, children: [] };
    }

    if (node.type === 'RECTANGLE') {
      const base = await this.base(node, parent);
      return { ...base, kind: 'FRAME', clips: false, children: [] };
    }

    if (CONTAINERS.has(node.type) && 'children' in node) {
      const kids = node.children.filter((c) => c.visible);
      const hasImageFill =
        'fills' in node && Array.isArray(node.fills) && (node.fills as Paint[]).some((p) => p.type === 'IMAGE');
      if (parent && kids.length && !hasImageFill && Math.max(node.width, node.height) <= ICON_MAX && this.isVectorOnly(node)) {
        return this.svg(node, parent);
      }
      if (this.hasMask(node)) {
        if (this.isVectorOnly(node)) return this.svg(node, parent);
        this.warn(node, 'Masked content flattened to an image.');
        return this.raster(node, parent);
      }
      const base = await this.base(node, parent);
      const frame: ExportFrame = {
        ...base,
        kind: 'FRAME',
        clips: 'clipsContent' in node ? node.clipsContent : false,
        children: [],
      };
      const layout = await this.autoLayout(node);
      if (layout) frame.layout = layout;
      if ('overflowDirection' in node && node.overflowDirection !== 'NONE') frame.scroll = node.overflowDirection;
      // Figma lists children bottom→top, which is also DOM paint order.
      for (const child of kids) {
        const c = await this.node(child, node);
        if (c) frame.children.push(c);
      }
      return frame;
    }

    this.warn(node, `${node.type} layers are exported as images.`);
    return this.raster(node, parent);
  }
}

/** Count visible nodes so the UI can show a determinate progress bar. */
export function countNodes(nodes: readonly SceneNode[]): number {
  let n = 0;
  const walk = (x: SceneNode) => {
    if (!x.visible) return;
    n++;
    if ('children' in x) x.children.forEach(walk);
  };
  nodes.forEach(walk);
  return n;
}

export async function serializeNodes(nodes: readonly SceneNode[], opts: SerializeOptions): Promise<ExportBundle> {
  const s = new Serializer(opts);
  const roots: ExportNode[] = [];
  for (const n of nodes) {
    const r = await s.node(n, null);
    if (r) roots.push(r);
  }
  return { roots, assets: [...s.assets.values()], warnings: s.warnings, variables: s.variables };
}
