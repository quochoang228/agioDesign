/**
 * "Refine with AI": send generated code to the configured provider and ask for
 * a semantic, readable rewrite that renders identically. Embedded images are
 * swapped for short placeholders on the way out (they'd blow the token budget)
 * and restored on the way back.
 */
import type { CodeTab } from '../../codegen';

const DATA_URI = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;

export function stripAssets(code: string): { code: string; restore: (s: string) => string } {
  const map = new Map<string, string>();
  const stripped = code.replace(DATA_URI, (uri) => {
    for (const [k, v] of map) if (v === uri) return k;
    const key = `__ASSET_${map.size + 1}__`;
    map.set(key, uri);
    return key;
  });
  return {
    code: stripped,
    restore: (s) => s.replace(/__ASSET_\d+__/g, (k) => map.get(k) ?? k),
  };
}

export function buildRefinePrompt(lang: CodeTab['lang']): string {
  const what = lang === 'jsx' ? 'a React (JSX) component' : 'an HTML document';
  return `You are a senior front-end engineer. You receive ${what} generated automatically from a Figma design. Rewrite it as clean, production-quality code that renders EXACTLY the same.

Do:
- Use semantic elements (header, nav, main, section, article, footer, h1–h6, p, a, button, ul/li, figure) where the content clearly calls for them; keep heading levels sensible.
- Give classes short, meaningful names describing purpose (e.g. "pricing-card", "nav-link"); merge duplicate rules; keep the CSS in the same place it is now.
- Add alt text to informative images and aria-labels to icon-only controls.
- Keep every visual value (sizes, colours, fonts, gradients, shadows, media queries, CSS variables) and every placeholder like __ASSET_1__ exactly as given.

Don't:
- Don't change layout, spacing, colours or typography; don't add frameworks, scripts or new dependencies; don't drop content.

Reply with ONLY the complete rewritten file in a single fenced code block.`;
}

/** Pull the code out of a fenced reply (or return the reply as-is). */
export function extractCode(raw: string): string {
  const fences = [...raw.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)];
  if (fences.length) return fences.reduce((a, m) => (m[1].length > a.length ? m[1] : a), '').trim() + '\n';
  return raw.trim() + '\n';
}
