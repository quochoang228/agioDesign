/**
 * Pure CSS value parsers used by the converter. Kept free of DOM access so they
 * can be unit-tested in Node (`npm test`); anything needing a live browser
 * (colour resolution via canvas, computed styles) stays in converter.ts.
 */

export function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Split a CSS value on top-level commas, respecting parentheses depth. Essential
 * for `background-image` / `box-shadow` where commas appear both BETWEEN layers
 * and inside `rgba(...)`, `linear-gradient(...)` and `url(...)` (incl. data URIs).
 * A naive regex shatters a `url(data:…)` that follows a gradient.
 */
export function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Convert a CSS linear-gradient direction ("45deg", "to top right") to degrees. */
export function parseGradientAngle(token: string): number {
  const t = token.trim();
  const deg = t.match(/(-?[\d.]+)deg/);
  if (deg) return ((parseFloat(deg[1]) % 360) + 360) % 360;
  if (t.startsWith('to ')) {
    const dir = t.slice(3).trim();
    const map: Record<string, number> = {
      top: 0,
      'top right': 45,
      'right top': 45,
      right: 90,
      'bottom right': 135,
      'right bottom': 135,
      bottom: 180,
      'bottom left': 225,
      'left bottom': 225,
      left: 270,
      'top left': 315,
      'left top': 315,
    };
    if (dir in map) return map[dir];
  }
  // turn / rad units, else default "to bottom".
  const turn = t.match(/(-?[\d.]+)turn/);
  if (turn) return (((parseFloat(turn[1]) * 360) % 360) + 360) % 360;
  const rad = t.match(/(-?[\d.]+)rad/);
  if (rad) return (((parseFloat(rad[1]) * 180) / Math.PI) % 360 + 360) % 360;
  return 180;
}

export function mapFontWeight(w: string): number {
  if (w === 'normal') return 400;
  if (w === 'bold') return 700;
  const n = parseInt(w, 10);
  return Number.isFinite(n) ? n : 400;
}

/** Map one layer's CSS background-size/repeat to a Figma image scale mode. */
export function bgScaleMode(size: string, repeat: string): 'FILL' | 'FIT' | 'TILE' {
  const s = size.trim();
  if (s === 'contain') return 'FIT';
  if (s === 'cover' || s === '100% 100%' || s === '100%') return 'FILL';
  if (/^repeat/.test(repeat.trim())) return 'TILE';
  return 'FILL';
}
