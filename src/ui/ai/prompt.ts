/**
 * System prompt + output cleanup for the "generate design as HTML" flow. The
 * model returns one self-contained HTML document, which the existing
 * `htmlToLayerTree` pipeline converts into editable Figma layers.
 */

export function buildSystemPrompt(width: number): string {
  return `You are a senior product designer who outputs production-quality UI as a single self-contained HTML document. Your output is rendered offscreen and converted into editable Figma layers, so structural, measurable markup matters.

OUTPUT RULES — follow exactly:
- Return ONLY the HTML document. No markdown, no \`\`\` fences, no commentary before or after.
- One file: a complete <!doctype html> with <head> (inline <style>) and <body>. No external CSS/JS files, no <script>, no web fonts that require network beyond Google Fonts <link> (avoid them — prefer system/font stacks).
- Design for a canvas exactly ${width}px wide. The root/body should be ${width}px wide (or full-bleed to it). Lay out real, finished content — never lorem-ipsum-only placeholders.
- Use flexbox for layout (the converter maps flex → Figma auto-layout). Give sections clear padding, gap, and alignment.
- Images: only <img> with absolute https URLs (or omit). Use https://picsum.photos/seed/<word>/<w>/<h> for photos when you need them.
- Use real hex/rgb/hsl colors, explicit font-size/line-height/font-weight, border-radius, and box-shadow where appropriate.

DESIGN QUALITY:
- Avoid generic AI aesthetics: no default Inter/Roboto/Arial-everything, no purple-gradient-on-white cliché unless the brief calls for it. Choose a cohesive palette and type system that fits the product's domain.
- Establish clear visual hierarchy, consistent spacing scale, and accessible contrast.
- Build the specific screen requested; if details are unspecified, make tasteful, concrete choices rather than asking.`;
}

/**
 * Pull a clean HTML document out of the model's reply: strip ``` fences and any
 * stray prose, keeping from the first `<!doctype`/`<html`/`<body`/`<div` onward.
 */
export function extractHtml(raw: string): string {
  let text = raw.trim();

  // Strip a fenced block if the model wrapped its answer.
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const lower = text.toLowerCase();
  const markers = ['<!doctype', '<html', '<body', '<div', '<section', '<main', '<header'];
  let start = -1;
  for (const m of markers) {
    const i = lower.indexOf(m);
    if (i !== -1 && (start === -1 || i < start)) start = i;
  }
  if (start > 0) text = text.slice(start);
  return text.trim();
}
