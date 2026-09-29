/**
 * Shared contract between the UI iframe (DOM access) and the plugin sandbox
 * (Figma API access). The UI does all DOM measurement and serialises a plain,
 * structurally-cloneable tree of `LayerNode`s; the sandbox turns that tree into
 * real Figma nodes. Keeping everything plain-serialisable is what lets the two
 * worlds talk over `postMessage`.
 */

export type RGBA = { r: number; g: number; b: number; a: number };

export interface SolidPaintData {
  type: 'SOLID';
  color: RGBA;
}

export interface GradientStopData {
  position: number;
  color: RGBA;
}

export interface GradientPaintData {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL';
  stops: GradientStopData[];
  /** CSS angle in degrees (linear only; 0 = to top, 90 = to right). */
  angle: number;
}

export interface ImagePaintData {
  type: 'IMAGE';
  /**
   * Raw bytes of the decoded image, ready for `figma.createImage`. A typed array
   * (not number[]) so postMessage clones it as one buffer instead of boxing
   * every byte.
   */
  bytes: Uint8Array;
  scaleMode: 'FILL' | 'FIT' | 'TILE';
  /** Source URL, resolved to `bytes` by the UI before sending to the sandbox. */
  src?: string;
}

export type PaintData = SolidPaintData | GradientPaintData | ImagePaintData;

export interface BorderData {
  color: RGBA;
  /** Per-side weights (px). 0 = no border on that side. */
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type LayerType = 'FRAME' | 'TEXT' | 'IMAGE' | 'SVG';

export interface BaseLayer {
  type: LayerType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  cornerRadius?: [number, number, number, number];
  fills?: PaintData[];
  border?: BorderData;
  /** Drop shadow effects extracted from CSS `box-shadow`. */
  shadows?: ShadowData[];
  /** Whether overflow was clipped (becomes `clipsContent`). */
  clipsContent?: boolean;
  /** CSS flex-grow of this element — used for auto-layout `layoutGrow`. */
  flexGrow?: number;
}

export interface ShadowData {
  color: RGBA;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  inset: boolean;
}

export interface AutoLayoutData {
  mode: 'HORIZONTAL' | 'VERTICAL';
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlign: 'MIN' | 'CENTER' | 'MAX';
}

export interface FrameLayer extends BaseLayer {
  type: 'FRAME';
  autoLayout?: AutoLayoutData;
  children: LayerNode[];
}

/** A run of characters [start, end) sharing one inline style (bold span, link…). */
export interface StyleRun {
  start: number;
  end: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  color: RGBA;
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  letterSpacing: number;
}

export interface TextLayer extends BaseLayer {
  type: 'TEXT';
  characters: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  lineHeight: number;
  letterSpacing: number;
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textColor: RGBA;
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER';
  /** True if the text rendered across more than one line; controls auto-resize. */
  multiline: boolean;
  /** Per-segment style overrides (bold/italic/colour/links within a paragraph). */
  runs?: StyleRun[];
}

export interface ImageLayer extends BaseLayer {
  type: 'IMAGE';
}

export interface SvgLayer extends BaseLayer {
  type: 'SVG';
  svg: string;
}

export type LayerNode = FrameLayer | TextLayer | ImageLayer | SvgLayer;

/** Render-width category. `custom` uses `ConvertOptions.customWidth`. */
export type WidthPreset = 'mobile' | 'tablet' | 'desktop' | 'custom';

/** Preset render widths (px) per device category. */
export const WIDTH_PRESETS: Record<Exclude<WidthPreset, 'custom'>, number> = {
  mobile: 390,
  tablet: 768,
  desktop: 1280,
};

/** Resolve the effective render width (px) from the chosen options. */
export function resolveRenderWidth(o: Pick<ConvertOptions, 'widthPreset' | 'customWidth'>): number {
  const raw = o.widthPreset === 'custom' ? o.customWidth : WIDTH_PRESETS[o.widthPreset];
  return Math.min(4096, Math.max(64, Math.round(raw) || WIDTH_PRESETS.mobile));
}

/** Options the user controls from the UI. */
export interface ConvertOptions {
  useAutoLayout: boolean;
  importImages: boolean;
  wrapInComponent: boolean;
  scale: number;
  /** Which render-width category is selected. */
  widthPreset: WidthPreset;
  /** Render width (px) used when `widthPreset === 'custom'`. */
  customWidth: number;
}

/** Plugin window size limits (px). The UI's resize grip clamps to these too. */
export const WINDOW_MIN = { width: 360, height: 480 };
export const WINDOW_MAX = { width: 1200, height: 1000 };
export const WINDOW_DEFAULT = { width: 440, height: 640 };

export function clampWindow(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(Math.min(WINDOW_MAX.width, Math.max(WINDOW_MIN.width, width))),
    height: Math.round(Math.min(WINDOW_MAX.height, Math.max(WINDOW_MIN.height, height))),
  };
}

/* ---- messages: UI -> sandbox ---- */

import type { AgentSettings } from './agent';
import type { ExportBundle, ExportOptions, SelectionItem } from './export';

export type UiToPluginMessage =
  | {
      type: 'IMPORT';
      tree: LayerNode;
      options: ConvertOptions;
      sourceName: string;
      /** Position within a multi-file batch (0-based); roots are tiled left→right. */
      batchIndex?: number;
      batchTotal?: number;
    }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; options: ConvertOptions }
  | { type: 'AGENT_GET_SETTINGS' }
  | { type: 'AGENT_SAVE_SETTINGS'; settings: AgentSettings }
  | { type: 'EXEC_TOOL'; id: string; name: string; args: unknown }
  /** `save` persists the size for next launch (sent when a resize drag ends). */
  | { type: 'RESIZE'; width: number; height: number; save?: boolean }
  | { type: 'NOTIFY'; message: string; error?: boolean }
  | { type: 'CANCEL' }
  /** Figma → HTML: ask for persisted export options + current selection. */
  | { type: 'EXPORT_GET_STATE' }
  | { type: 'EXPORT_SAVE_SETTINGS'; options: ExportOptions }
  /** Serialise the selection (or `ids`) into an ExportBundle. */
  | { type: 'EXPORT_SELECTION'; requestId: string; ids?: string[]; density: 1 | 2 | 3; srcset: boolean }
  /** Select and zoom to a node (e.g. from a warning). */
  | { type: 'FOCUS_NODE'; id: string };

/* ---- messages: sandbox -> UI ---- */

export type PluginToUiMessage =
  | { type: 'SETTINGS'; options: ConvertOptions }
  | { type: 'AGENT_SETTINGS'; settings: AgentSettings }
  | { type: 'TOOL_RESULT'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'PROGRESS'; done: number; total: number }
  | { type: 'DONE'; nodeCount: number }
  | { type: 'ERROR'; message: string }
  | { type: 'SELECTION'; items: SelectionItem[] }
  | { type: 'EXPORT_SETTINGS'; options: ExportOptions }
  | { type: 'EXPORT_PROGRESS'; requestId: string; done: number; total: number }
  | { type: 'EXPORT_RESULT'; requestId: string; bundle: ExportBundle }
  | { type: 'EXPORT_ERROR'; requestId: string; message: string };
