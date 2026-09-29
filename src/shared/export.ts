/**
 * Figma → HTML contract. The sandbox walks the selected Figma nodes and
 * serialises them into a plain `ExportNode` tree (plus binary assets); the code
 * generator (`src/ui/export/`) turns that tree into HTML/CSS. The generator is
 * pure — no DOM, no Figma API — so it runs in the UI, in the sandbox (Dev Mode
 * codegen, agent tool) and in unit tests alike.
 *
 * Geometry is always relative to the parent `ExportNode`, already un-rotated:
 * `x/y/width/height` describe the node's own (pre-transform) box and `matrix`
 * carries rotation/skew when present.
 */

export type RGBA = { r: number; g: number; b: number; a: number };

/** 2×3 affine matrix [[a, c, e], [b, d, f]] in Figma's row-major order. */
export type Transform2D = [[number, number, number], [number, number, number]];

export interface ColorStop {
  position: number;
  color: RGBA;
  /** Name of a bound Figma variable, when the stop colour is tokenised. */
  variable?: string;
}

export type ExportPaint =
  | { type: 'SOLID'; color: RGBA; variable?: string }
  | {
      type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
      stops: ColorStop[];
      /** Figma `gradientTransform` (maps node space → gradient space). */
      transform: Transform2D;
      opacity: number;
    }
  | {
      type: 'IMAGE';
      assetId: string;
      scaleMode: 'FILL' | 'FIT' | 'TILE' | 'CROP';
      /** Present for CROP: maps node space → image space. */
      imageTransform?: Transform2D;
      /** TILE zoom factor. */
      scalingFactor?: number;
      opacity: number;
    };

export interface ExportStroke {
  paints: ExportPaint[];
  /** Per-side weights: top, right, bottom, left. */
  weights: [number, number, number, number];
  align: 'INSIDE' | 'CENTER' | 'OUTSIDE';
  dashed: boolean;
}

export type ExportEffect =
  | {
      type: 'DROP_SHADOW' | 'INNER_SHADOW';
      color: RGBA;
      x: number;
      y: number;
      blur: number;
      spread: number;
    }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number };

export type Sizing = 'FIXED' | 'HUG' | 'FILL';
export type Constraint = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE';

export interface AutoLayout {
  direction: 'ROW' | 'COLUMN';
  wrap: boolean;
  gap: number;
  /** Gap between wrapped rows/columns. */
  crossGap: number;
  /** Top, right, bottom, left. */
  padding: [number, number, number, number];
  justify: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  align: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  /** Bound variable names for spacing tokens, keyed by field. */
  variables?: Partial<Record<'gap' | 'crossGap' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft', string>>;
}

export interface ExportNodeBase {
  /** Figma node id (stable across exports; used to address nodes). */
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Only set when the node is rotated/skewed (translation lives in x/y). */
  matrix?: [number, number, number, number];
  opacity: number;
  blendMode?: string;
  /** Positioned absolutely inside its parent (parent has no auto layout, or ABSOLUTE positioning). */
  absolute: boolean;
  sizingH: Sizing;
  sizingV: Sizing;
  constraints: { h: Constraint; v: Constraint };
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  fills: ExportPaint[];
  stroke?: ExportStroke;
  /** Top-left, top-right, bottom-right, bottom-left. */
  radius?: [number, number, number, number];
  effects: ExportEffect[];
  /** Name of the main component when the node is an instance/component. */
  component?: string;
}

export interface ExportFrame extends ExportNodeBase {
  kind: 'FRAME';
  layout?: AutoLayout;
  clips: boolean;
  /** A full ellipse (rendered with border-radius: 50%). */
  ellipse?: boolean;
  scroll?: 'HORIZONTAL' | 'VERTICAL' | 'BOTH';
  children: ExportNode[];
}

export interface TextRun {
  start: number;
  end: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: { unit: 'PX' | 'PERCENT' | 'AUTO'; value: number };
  letterSpacing: { unit: 'PX' | 'PERCENT'; value: number };
  fills: ExportPaint[];
  decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  link?: string;
}

export interface ExportText extends ExportNodeBase {
  kind: 'TEXT';
  characters: string;
  runs: TextRun[];
  alignH: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  alignV: 'TOP' | 'CENTER' | 'BOTTOM';
  autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';
  maxLines?: number;
}

export interface ExportSvg extends ExportNodeBase {
  kind: 'SVG';
  svg: string;
}

/** A node flattened to a bitmap (masks, unsupported effects…). */
export interface ExportRaster extends ExportNodeBase {
  kind: 'RASTER';
  assetId: string;
}

export type ExportNode = ExportFrame | ExportText | ExportSvg | ExportRaster;

export interface ExportAsset {
  id: string;
  /** Filename stem, already slugified and unique within the export. */
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** Optional higher-density copy (for srcset), same mime. */
  hiDpi?: { scale: number; bytes: Uint8Array };
}

export interface ExportWarning {
  nodeId?: string;
  nodeName?: string;
  message: string;
}

/** Everything the sandbox hands to the generator for one export. */
export interface ExportBundle {
  roots: ExportNode[];
  assets: ExportAsset[];
  warnings: ExportWarning[];
  /** Resolved variable values: name → CSS value (colour or px number). */
  variables: Record<string, string>;
}

/* ---- options ---- */

export type ExportLayout = 'fixed' | 'fluid' | 'scale';
export type ExportFormat = 'html' | 'tailwind' | 'react' | 'react-tailwind';

export interface ExportOptions {
  format: ExportFormat;
  /** fixed = exact px; fluid = flex/constraints, container max-width; scale = proportional to viewport. */
  layout: ExportLayout;
  units: 'px' | 'rem';
  /** Raster density: 1, 2 or 3 (adds a srcset when > 1 and images go to files). */
  density: 1 | 2 | 3;
  images: 'embed' | 'files';
  cssMode: 'style-tag' | 'external' | 'inline';
  useVariables: boolean;
  /** Pick semantic tags (h1, button, a…) from layer names and hyperlinks. */
  semanticTags: boolean;
  /** Class-name prefix, e.g. "fx-". */
  classPrefix: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'html',
  layout: 'fluid',
  units: 'px',
  density: 2,
  images: 'embed',
  cssMode: 'style-tag',
  useVariables: true,
  semanticTags: true,
  classPrefix: '',
};

/** A root frame assigned to a breakpoint (min viewport width). */
export interface Breakpoint {
  rootId: string;
  minWidth: number;
}

/** Summary of a top-level selected node, pushed to the UI on selection change. */
export interface SelectionItem {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
}
