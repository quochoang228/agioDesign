/**
 * CSS declarations → Tailwind utility classes. Common properties map to named
 * utilities (`flex`, `items-center`, `w-[120px]`…); everything else falls back
 * to Tailwind's arbitrary-property syntax (`[mix-blend-mode:multiply]`), so the
 * output is always complete. Requires Tailwind ≥ 3.2 (or 4).
 */
import type { Decls } from './css';

/** Encode an arbitrary value: spaces → underscores, literal underscores escaped. */
export function twValue(v: string): string {
  // Double quotes would end the class="" attribute; Tailwind accepts single quotes.
  return v.replace(/_/g, '\\_').replace(/"/g, "'").replace(/\s+/g, '_');
}

const KEYWORDS: Record<string, Record<string, string>> = {
  display: { flex: 'flex', block: 'block', none: 'hidden', inline: 'inline', 'inline-block': 'inline-block', grid: 'grid' },
  position: { absolute: 'absolute', relative: 'relative', static: 'static', fixed: 'fixed' },
  'flex-direction': { column: 'flex-col', row: 'flex-row' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  'justify-content': { center: 'justify-center', 'flex-end': 'justify-end', 'flex-start': 'justify-start', 'space-between': 'justify-between' },
  'align-items': { 'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', baseline: 'items-baseline', stretch: 'items-stretch' },
  'align-self': { stretch: 'self-stretch', center: 'self-center', 'flex-start': 'self-start', 'flex-end': 'self-end' },
  flex: { '1 1 0': 'flex-1' },
  'flex-shrink': { '0': 'shrink-0', '1': 'shrink' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto' },
  'overflow-x': { auto: 'overflow-x-auto', hidden: 'overflow-x-hidden' },
  'overflow-y': { auto: 'overflow-y-auto', hidden: 'overflow-y-hidden' },
  'text-align': { center: 'text-center', right: 'text-right', justify: 'text-justify', left: 'text-left' },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'white-space': { 'pre-wrap': 'whitespace-pre-wrap', pre: 'whitespace-pre', nowrap: 'whitespace-nowrap', normal: 'whitespace-normal' },
  'text-decoration': { underline: 'underline', 'line-through': 'line-through', none: 'no-underline' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  'text-overflow': { ellipsis: 'text-ellipsis' },
  'object-fit': { cover: 'object-cover', contain: 'object-contain' },
  margin: { '0 auto': 'mx-auto' },
  width: { '100%': 'w-full' },
  'max-width': { '100%': 'max-w-full' },
};

/** Properties whose value maps to `<prefix>-[value]`. */
const PREFIX: Record<string, string> = {
  width: 'w',
  height: 'h',
  'min-width': 'min-w',
  'max-width': 'max-w',
  'min-height': 'min-h',
  'max-height': 'max-h',
  left: 'left',
  right: 'right',
  top: 'top',
  bottom: 'bottom',
  'row-gap': 'gap-y',
  'column-gap': 'gap-x',
  'line-height': 'leading',
  'letter-spacing': 'tracking',
  'font-weight': 'font',
  opacity: 'opacity',
  order: 'order',
  'box-shadow': 'shadow',
  'outline-offset': 'outline-offset',
};

const SIMPLE = /^[^\s,()]+$|^(calc|var|min|max|clamp)\(.*\)$/;

function one(prop: string, value: string): string {
  const kw = KEYWORDS[prop]?.[value];
  if (kw) return kw;
  if (value === 'unset' || value === 'auto' || value === 'none' || value === 'normal') return `[${prop}:${value}]`;
  const v = twValue(value);
  if (PREFIX[prop]) return `${PREFIX[prop]}-[${v}]`;
  switch (prop) {
    case 'gap':
    case 'padding':
      if (SIMPLE.test(value)) return `${prop === 'gap' ? 'gap' : 'p'}-[${v}]`;
      break;
    case 'border-radius':
      if (SIMPLE.test(value)) return `rounded-[${v}]`;
      break;
    case 'font-size':
      return `text-[length:${v}]`;
    case 'color':
      return `text-[color:${v}]`;
    case 'background':
      if (/^(#|rgba?\(|var\()/.test(value) && SIMPLE.test(value.replace(/\s+/g, ''))) return `bg-[${v}]`;
      break;
  }
  return `[${prop}:${v}]`;
}

/** Tailwind classes for a declaration set, each prefixed with `variant` (e.g. "min-[768px]:"). */
export function toTailwind(d: Decls, variant = ''): string[] {
  return Object.entries(d).map(([k, v]) => variant + one(k, v));
}
