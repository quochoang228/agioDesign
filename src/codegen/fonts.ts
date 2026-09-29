/**
 * Font handling: CSS font stacks, and a Google Fonts `<link>` for families that
 * Google hosts. Anything else is reported so the user can self-host it.
 */

const GOOGLE_FONTS = new Set(
  [
    'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Source Sans 3', 'Source Sans Pro', 'Oswald',
    'Raleway', 'Noto Sans', 'Nunito', 'Nunito Sans', 'Ubuntu', 'Rubik', 'Merriweather', 'Playfair Display', 'PT Sans',
    'PT Serif', 'Work Sans', 'Mulish', 'Fira Sans', 'Fira Code', 'Quicksand', 'Barlow', 'Barlow Condensed', 'Manrope',
    'DM Sans', 'DM Serif Display', 'DM Mono', 'Karla', 'Heebo', 'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono',
    'Josefin Sans', 'Libre Baskerville', 'Libre Franklin', 'Lora', 'Noto Serif', 'Roboto Condensed', 'Roboto Mono',
    'Roboto Slab', 'Roboto Flex', 'Space Grotesk', 'Space Mono', 'Plus Jakarta Sans', 'Outfit', 'Sora', 'Lexend',
    'Figtree', 'Onest', 'Geist', 'Geist Mono', 'Be Vietnam Pro', 'Archivo', 'Cabin', 'Crimson Text', 'EB Garamond',
    'Cormorant Garamond', 'Bitter', 'Arimo', 'Tinos', 'Cousine', 'Hind', 'Mukta', 'Kanit', 'Prompt', 'Sarabun',
    'Titillium Web', 'Exo 2', 'Urbanist', 'Red Hat Display', 'Red Hat Text', 'Albert Sans', 'Public Sans',
    'Instrument Sans', 'Instrument Serif', 'Bricolage Grotesque', 'Schibsted Grotesk', 'Epilogue', 'Syne',
    'JetBrains Mono', 'Source Code Pro', 'Inconsolata', 'Noto Sans Mono', 'Bebas Neue', 'Anton', 'Abril Fatface',
    'Pacifico', 'Caveat', 'Dancing Script', 'Lobster', 'Satisfy', 'Comfortaa', 'Varela Round', 'Assistant',
    'Oxygen', 'Signika', 'Asap', 'Alegreya', 'Spectral', 'Zilla Slab', 'Chivo', 'Overpass', 'Readex Pro',
    'Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC', 'Noto Sans TC', 'M PLUS 1p', 'Material Symbols Outlined',
    'Material Icons',
  ].map((f) => f.toLowerCase()),
);

/** Fonts every OS ships (or a sensible local alias exists) — no warning needed. */
const SYSTEM = new Set(
  [
    'Arial', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Times', 'Georgia', 'Courier New', 'Courier',
    'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'SF Pro', 'SF Pro Display', 'SF Pro Text', 'SF Pro Rounded',
    'SF Mono', 'SF Compact', 'New York', 'Menlo', 'Monaco', 'system-ui',
  ].map((f) => f.toLowerCase()),
);

export function isGoogleFont(family: string): boolean {
  return GOOGLE_FONTS.has(family.toLowerCase());
}

export function isSystemFont(family: string): boolean {
  return SYSTEM.has(family.toLowerCase());
}

function generic(family: string): string {
  if (/mono|code|courier|consol/i.test(family)) return 'monospace';
  if (/serif/i.test(family) && !/sans/i.test(family)) return 'serif';
  if (/georgia|times|garamond|baskerville|merriweather|lora|playfair|crimson|spectral/i.test(family)) return 'serif';
  return 'sans-serif';
}

export function fontStack(family: string): string {
  const q = /^[a-z-]+$/i.test(family) ? family : `"${family.replace(/"/g, '')}"`;
  if (/^SF (Pro|Compact)/i.test(family)) return `${q}, -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
  if (/^SF Mono/i.test(family)) return `${q}, ui-monospace, Menlo, monospace`;
  return `${q}, ${generic(family)}`;
}

/** Usage collected while generating: family → set of "italic,weight" axes. */
export type FontUsage = Map<string, Set<string>>;

export function recordFont(usage: FontUsage, family: string, weight: number, italic: boolean): void {
  let axes = usage.get(family);
  if (!axes) usage.set(family, (axes = new Set()));
  axes.add(`${italic ? 1 : 0},${Math.round(weight)}`);
}

/** One css2 URL for all Google-hosted families in use, or undefined. */
export function googleFontsHref(usage: FontUsage): string | undefined {
  const families: string[] = [];
  for (const [family, axes] of usage) {
    if (!isGoogleFont(family)) continue;
    const tuples = [...axes]
      .map((a) => a.split(',').map(Number) as [number, number])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const hasItalic = tuples.some((t) => t[0] === 1);
    const spec = hasItalic
      ? `ital,wght@${tuples.map((t) => `${t[0]},${t[1]}`).join(';')}`
      : `wght@${[...new Set(tuples.map((t) => t[1]))].join(';')}`;
    families.push(`family=${family.replace(/ /g, '+')}:${spec}`);
  }
  if (!families.length) return undefined;
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
}
