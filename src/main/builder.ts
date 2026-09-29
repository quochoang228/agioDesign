/**
 * LayerNode tree → real Figma nodes. Runs in the plugin sandbox (Figma API
 * available, no DOM). Fonts are preloaded before any text is set, because the
 * Figma API requires a loaded font before assigning characters.
 */
import type {
  LayerNode,
  FrameLayer,
  TextLayer,
  PaintData,
  RGBA,
  ConvertOptions,
} from '../shared/types';

/**
 * Build Figma's linear gradientTransform from a CSS angle (0=to top, 90=to
 * right). Maps so the gradient runs corner-to-corner exactly like CSS: the
 * progress along the gradient line equals the projection of each point onto the
 * direction, scaled so 0%/100% land on the bounding-box corners.
 */
function linearTransform(angleDeg: number): Transform {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const s = 1 / (Math.abs(dx) + Math.abs(dy) || 1);
  return [
    [s * dx, s * dy, 0.5 - 0.5 * s * (dx + dy)],
    [-s * dy, s * dx, 0.5 + 0.5 * s * (dy - dx)],
  ];
}

/** Centered radial gradient covering the box (radius = half width/height). */
function radialTransform(): Transform {
  return [
    [0.5, 0, 0.25],
    [0, 0.5, 0.25],
  ];
}

function rgbaToPaint(c: RGBA): SolidPaint {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

function toFills(paints: PaintData[] | undefined): Paint[] {
  if (!paints) return [];
  const out: Paint[] = [];
  for (const p of paints) {
    if (p.type === 'SOLID') {
      out.push(rgbaToPaint(p.color));
    } else if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
      const stops: ColorStop[] = p.stops.map((s) => ({
        position: Math.min(1, Math.max(0, s.position)),
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      }));
      out.push({
        type: p.type,
        gradientTransform:
          p.type === 'GRADIENT_RADIAL' ? radialTransform() : linearTransform(p.angle),
        gradientStops: stops,
      });
    } else if (p.type === 'IMAGE') {
      if (!p.bytes.length) continue; // unresolved fetch — skip
      const image = figma.createImage(p.bytes);
      if (p.scaleMode === 'TILE') {
        out.push({ type: 'IMAGE', scaleMode: 'TILE', imageHash: image.hash, scalingFactor: 0.5 });
      } else {
        out.push({ type: 'IMAGE', scaleMode: p.scaleMode, imageHash: image.hash });
      }
    }
  }
  return out;
}

function applyCommon(node: FrameNode | RectangleNode, layer: LayerNode): void {
  if (layer.border) {
    const b = layer.border;
    node.strokes = [rgbaToPaint(b.color)];
    node.strokeAlign = 'INSIDE';
    if (b.top === b.right && b.right === b.bottom && b.bottom === b.left) {
      node.strokeWeight = b.top;
    } else {
      // Per-side weights (Figma allows one stroke colour, independent widths).
      node.strokeTopWeight = b.top;
      node.strokeRightWeight = b.right;
      node.strokeBottomWeight = b.bottom;
      node.strokeLeftWeight = b.left;
    }
  }
  if (layer.cornerRadius) {
    const [tl, tr, br, bl] = layer.cornerRadius;
    if ('topLeftRadius' in node) {
      node.topLeftRadius = tl;
      node.topRightRadius = tr;
      node.bottomRightRadius = br;
      node.bottomLeftRadius = bl;
    }
  }
  if (layer.shadows && layer.shadows.length) {
    node.effects = layer.shadows.map((s) => ({
      type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
      offset: { x: s.offsetX, y: s.offsetY },
      radius: s.blur,
      spread: s.spread,
      visible: true,
      blendMode: 'NORMAL',
    })) as Effect[];
  }
}

const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

function weightToStyle(weight: number, italic: boolean): string {
  const base =
    weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : weight >= 500 ? 'Medium' : 'Regular';
  return italic ? (base === 'Regular' ? 'Italic' : `${base} Italic`) : base;
}

/** Try the requested font, fall back through sensible defaults. */
async function loadFontSafe(family: string, weight: number, italic: boolean): Promise<FontName> {
  const candidates: FontName[] = [
    { family, style: weightToStyle(weight, italic) },
    { family, style: italic ? 'Italic' : 'Regular' },
    { family, style: 'Regular' },
    FALLBACK_FONT,
  ];
  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font);
      return font;
    } catch {
      // try next
    }
  }
  await figma.loadFontAsync(FALLBACK_FONT);
  return FALLBACK_FONT;
}

/** Preload every distinct font referenced by text layers in the tree. */
export async function preloadFonts(root: LayerNode): Promise<Map<string, FontName>> {
  const wanted = new Set<string>();
  const collect = (n: LayerNode) => {
    if (n.type === 'TEXT') {
      wanted.add(`${n.fontFamily}:${n.fontWeight}:${n.italic}`);
      n.runs?.forEach((r) => wanted.add(`${r.fontFamily}:${r.fontWeight}:${r.italic}`));
    }
    if (n.type === 'FRAME') n.children.forEach(collect);
  };
  collect(root);

  const resolved = new Map<string, FontName>();
  for (const key of wanted) {
    const [family, weight, italic] = key.split(':');
    resolved.set(key, await loadFontSafe(family, parseInt(weight, 10), italic === 'true'));
  }
  if (!resolved.size) await figma.loadFontAsync(FALLBACK_FONT);
  return resolved;
}

let built = 0;

async function buildText(layer: TextLayer, fonts: Map<string, FontName>): Promise<TextNode> {
  const node = figma.createText();
  const key = `${layer.fontFamily}:${layer.fontWeight}:${layer.italic}`;
  node.fontName = fonts.get(key) || FALLBACK_FONT;
  node.characters = layer.characters;
  node.fontSize = layer.fontSize;
  node.fills = [rgbaToPaint(layer.textColor)];
  node.lineHeight = { value: layer.lineHeight, unit: 'PIXELS' };
  node.letterSpacing = { value: layer.letterSpacing, unit: 'PIXELS' };
  node.textAlignHorizontal = layer.textAlign === 'JUSTIFIED' ? 'JUSTIFIED' : layer.textAlign;
  node.textDecoration = layer.textDecoration;
  node.textCase = layer.textCase;
  node.name = layer.name || 'Text';

  // Apply per-run styling (bold/italic/colour/links inside the paragraph).
  if (layer.runs && layer.runs.length) {
    const len = node.characters.length;
    for (const run of layer.runs) {
      const start = Math.max(0, Math.min(run.start, len));
      const end = Math.max(start, Math.min(run.end, len));
      if (end <= start) continue;
      const font = fonts.get(`${run.fontFamily}:${run.fontWeight}:${run.italic}`) || FALLBACK_FONT;
      try {
        node.setRangeFontName(start, end, font);
        node.setRangeFontSize(start, end, run.fontSize);
        node.setRangeFills(start, end, [rgbaToPaint(run.color)]);
        node.setRangeTextDecoration(start, end, run.textDecoration);
        if (run.letterSpacing) {
          node.setRangeLetterSpacing(start, end, { value: run.letterSpacing, unit: 'PIXELS' });
        }
      } catch {
        /* a run may fall outside bounds after text-case transforms — skip it */
      }
    }
  }

  if (layer.multiline) {
    // Multi-line: fix width so wraps land where the browser put them; grow height.
    node.textAutoResize = 'HEIGHT';
    node.resize(Math.max(1, layer.width), Math.max(1, layer.height));
  } else {
    // Single-line: hug the content so a wider fallback font can't force a wrap
    // (which would shrink/shift the layout).
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  return node;
}

function buildFrameShell(layer: LayerNode): FrameNode {
  const node = figma.createFrame();
  node.name = layer.name;
  node.resize(Math.max(1, layer.width), Math.max(1, layer.height));
  node.fills = toFills(layer.fills);
  node.clipsContent = !!layer.clipsContent;
  applyCommon(node, layer);
  return node;
}

function applyAutoLayout(node: FrameNode, layer: FrameLayer): void {
  const al = layer.autoLayout;
  if (!al) return;
  node.layoutMode = al.mode;
  node.itemSpacing = al.itemSpacing;
  node.paddingTop = al.paddingTop;
  node.paddingRight = al.paddingRight;
  node.paddingBottom = al.paddingBottom;
  node.paddingLeft = al.paddingLeft;
  node.primaryAxisAlignItems = al.primaryAxisAlign;
  node.counterAxisAlignItems = al.counterAxisAlign;
  node.primaryAxisSizingMode = 'FIXED';
  node.counterAxisSizingMode = 'FIXED';
  // Enabling layoutMode makes Figma hug the contents, discarding the real size;
  // restore the measured box so `space-between` and alignment have room to work.
  node.resize(Math.max(0.01, layer.width), Math.max(0.01, layer.height));
}

/** Build a node and append it to `parent`, positioning by absolute offset. */
async function build(
  layer: LayerNode,
  parent: FrameNode | PageNode,
  fonts: Map<string, FontName>,
  options: ConvertOptions,
  onProgress: () => void,
): Promise<SceneNode> {
  let node: SceneNode;

  if (layer.type === 'TEXT') {
    node = await buildText(layer, fonts);
  } else if (layer.type === 'SVG') {
    try {
      node = figma.createNodeFromSvg(layer.svg);
      node.name = 'svg';
    } catch {
      node = buildFrameShell(layer);
    }
  } else {
    // FRAME or IMAGE both render as a frame shell.
    const frame = buildFrameShell(layer);
    if (layer.type === 'FRAME') {
      const autoLaid = options.useAutoLayout && !!layer.autoLayout;
      const childNodes: SceneNode[] = [];
      for (const child of layer.children) {
        const childNode = await build(child, frame, fonts, options, onProgress);
        childNodes.push(childNode);
        if (!autoLaid) {
          // Absolute positioning relative to this frame.
          childNode.x = child.x - layer.x;
          childNode.y = child.y - layer.y;
        }
      }
      if (autoLaid) {
        applyAutoLayout(frame, layer);
        // Apply flex-grow now that the parent is an auto-layout frame.
        layer.children.forEach((child, i) => {
          const cn = childNodes[i];
          if (child.flexGrow && 'layoutGrow' in cn) cn.layoutGrow = child.flexGrow;
        });
      }
    }
    node = frame;
  }

  parent.appendChild(node);
  built++;
  onProgress();
  return node;
}

export interface BuildOutcome {
  root: SceneNode;
  count: number;
}

export async function buildTree(
  tree: LayerNode,
  options: ConvertOptions,
  fonts: Map<string, FontName>,
  onProgress: (done: number) => void,
): Promise<BuildOutcome> {
  built = 0;
  const root = await build(tree, figma.currentPage, fonts, options, () => onProgress(built));

  if (options.scale !== 1 && 'rescale' in root) {
    root.rescale(options.scale);
  }

  let finalRoot: SceneNode = root;
  if (options.wrapInComponent && root.type === 'FRAME') {
    // createComponentFromNode replaces `root`, which is gone afterwards —
    // reading root.name then throws "node … does not exist". Grab it first.
    const name = root.name;
    const component = figma.createComponentFromNode(root);
    component.name = name;
    finalRoot = component;
  }

  // Caller positions the root (so multi-file batches can be tiled).
  return { root: finalRoot, count: built };
}
