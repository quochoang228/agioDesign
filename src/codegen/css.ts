/**
 * Small, dependency-free CSS helpers shared by the generator and the sandbox
 * serialiser. Nothing here may touch the DOM or the Figma API.
 */
import type { ExportLayout, ExportOptions, RGBA } from '../shared/export';

/** Ordered CSS declarations (insertion order is emission order). */
export type Decls = Record<string, string>;

/** Round to at most `p` decimals and drop trailing zeros. */
export function num(n: number, p = 2): string {
  const f = 10 ** p;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? '0' : String(r);
}

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** `#rrggbb` when opaque, otherwise `rgba()`. */
export function cssColor(c: RGBA, alphaMul = 1): string {
  const a = Math.min(1, Math.max(0, (c.a ?? 1) * alphaMul));
  if (a >= 0.999) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${num(a, 3)})`;
}

/** Wrap a colour in `var(--token, fallback)` when a variable is bound and opaque. */
export function tokenColor(c: RGBA, alphaMul: number, variable: string | undefined, useVars: boolean): string {
  const plain = cssColor(c, alphaMul);
  if (useVars && variable && (c.a ?? 1) * alphaMul >= 0.999) return `var(--${variable}, ${plain})`;
  return plain;
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Unit context: turns design px into the chosen output unit. */
export interface Units {
  layout: ExportLayout;
  rem: boolean;
  /** Length for layout/typography. */
  len(px: number): string;
  /** Hairline-ish lengths (borders, shadows) stay px unless scaling. */
  line(px: number): string;
}

export function makeUnits(opts: Pick<ExportOptions, 'layout' | 'units'>): Units {
  const scale = opts.layout === 'scale';
  const rem = opts.units === 'rem' && !scale;
  const len = (px: number) => {
    if (!px) return '0';
    if (scale) return `calc(${num(px)} * var(--u))`;
    if (rem) return `${num(px / 16, 4)}rem`;
    return `${num(px)}px`;
  };
  const line = (px: number) => {
    if (!px) return '0';
    return scale ? `calc(${num(px)} * var(--u))` : `${num(px)}px`;
  };
  return { layout: opts.layout, rem, len, line };
}

/** Collapse four side values into the shortest CSS shorthand. */
export function sides(v: [string, string, string, string]): string {
  const [t, r, b, l] = v;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

const BLEND: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

export function blendMode(mode: string | undefined): string | undefined {
  return mode ? BLEND[mode] : undefined;
}

export function declsToString(d: Decls, sep = '; '): string {
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${v}`)
    .join(sep);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without btoa/Buffer, so it runs in the Figma sandbox too. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==');
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=');
  }
  return out.join('');
}

export function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return 'png';
}
