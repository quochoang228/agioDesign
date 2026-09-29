/**
 * Public entry point of the Figma → code generator.
 *
 *   generate({ bundle, options, breakpoints?, target })
 *     → { document, tabs, files, warnings, report, stats }
 *
 * `document` is always a runnable single-file HTML page (used for the preview);
 * `tabs` is what the UI shows as code; `files` is the downloadable project.
 */
import type { Breakpoint, ExportBundle, ExportNode, ExportOptions, ExportWarning } from '../shared/export';
import type { Decls } from './css';
import { base64, declsToString, escapeAttr, escapeHtml, extForMime, makeUnits } from './css';
import type { BuildContext, El } from './build';
import { buildRoot } from './build';
import type { MatchReport, MEl } from './merge';
import { ClassNamer, cascade, firstSlot, mergeTrees } from './merge';
import { toTailwind } from './tailwind';
import type { FontUsage } from './fonts';
import { googleFontsHref, isGoogleFont, isSystemFont } from './fonts';
import type { ZipEntry } from './zip';

export { zip } from './zip';
export type { ZipEntry } from './zip';

export interface GenerateInput {
  bundle: ExportBundle;
  options: ExportOptions;
  /** ≥ 2 entries merge those roots into one responsive page. */
  breakpoints?: Breakpoint[];
  /** preview: images always inlined; download: honours `options.images`. */
  target: 'preview' | 'download';
  title?: string;
}

export interface CodeTab {
  label: string;
  lang: 'html' | 'css' | 'jsx';
  content: string;
}

export interface GenerateResult {
  document: string;
  tabs: CodeTab[];
  files: ZipEntry[];
  warnings: ExportWarning[];
  report?: MatchReport;
  stats: { elements: number; classes: number };
  /** Bare pieces for embedding elsewhere (Dev Mode codegen, agent tool). */
  parts: { markup: string; css: string; jsx?: string };
}

const RESET = `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
img, svg { display: block; max-width: none; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; text-align: inherit; }
a { color: inherit; text-decoration: inherit; }
ul, ol { list-style: none; }`;

const TAILWIND_CDN = 'https://cdn.tailwindcss.com';

interface Group {
  tree: MEl;
  /** Min-width per slot (slot 0 is the base style). */
  widths: number[];
  root: ExportNode;
}

function pascal(s: string): string {
  const p = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Z]/.test(p) ? p : `Export${p}`;
}

/* ---------------- JSX helpers ---------------- */

const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

function styleObject(d: Decls): string {
  const body = Object.entries(d)
    .map(([k, v]) => {
      const key = k.startsWith('--') ? JSON.stringify(k) : /^-webkit-/.test(k) ? `Webkit${camel(k.slice(8)).replace(/^./, (c) => c.toUpperCase())}` : camel(k);
      return `${key}: ${JSON.stringify(v)}`;
    })
    .join(', ');
  return `{{ ${body} }}`;
}

function svgToJsx(svg: string): string {
  return svg
    .replace(/\sstyle="([^"]*)"/g, (_m, css: string) => {
      const d: Decls = {};
      css.split(';').forEach((p) => {
        const i = p.indexOf(':');
        if (i > 0) d[p.slice(0, i).trim()] = p.slice(i + 1).trim();
      });
      return ` style=${styleObject(d)}`;
    })
    .replace(/\s(class)=/g, ' className=')
    .replace(/\s([a-zA-Z]+[-:][a-zA-Z-:]+)=/g, (m, name: string) => {
      if (/^(data|aria)-/.test(name)) return m;
      return ` ${name.replace(/[-:]([a-z])/g, (_x, c: string) => c.toUpperCase())}=`;
    });
}

function jsxText(t: string): string {
  if (/^[\p{L}\p{N}][\p{L}\p{N} .,!?'’:;&%@#+*=/-]*$/u.test(t) && !/ {2}|&/.test(t) && !/ $/.test(t)) return t;
  return `{${JSON.stringify(t)}}`;
}

const JSX_ATTR: Record<string, string> = { class: 'className', srcset: 'srcSet', for: 'htmlFor' };

/* ---------------- generator ---------------- */

export function generate(input: GenerateInput): GenerateResult {
  const { bundle, options, target } = input;
  const title = input.title || bundle.roots[0]?.name || 'Export';
  const isReact = options.format === 'react' || options.format === 'react-tailwind';
  const isTw = options.format === 'tailwind' || options.format === 'react-tailwind';
  const embed = target === 'preview' || options.images === 'embed';
  const assetPrefix = isReact ? '/assets/' : 'assets/';
  const warnings: ExportWarning[] = [...bundle.warnings];
  const assets = new Map(bundle.assets.map((a) => [a.id, a]));
  const usedAssets = new Set<string>();
  const fonts: FontUsage = new Map();

  const assetPath = (id: string, hi: boolean) => {
    const a = assets.get(id)!;
    const ext = extForMime(a.mime);
    return `${assetPrefix}${a.name}${hi && a.hiDpi ? `@${a.hiDpi.scale}x` : ''}.${ext}`;
  };
  const ctx: BuildContext = {
    opts: options,
    units: makeUnits(options),
    assetUrl: (id, hi) => {
      const a = assets.get(id);
      if (!a) return '';
      usedAssets.add(id);
      if (embed) return `data:${a.mime};base64,${base64(hi && a.hiDpi ? a.hiDpi.bytes : a.bytes)}`;
      return assetPath(id, false);
    },
    assetSrcset: (id) => {
      const a = assets.get(id);
      if (embed || !a?.hiDpi) return undefined;
      return `${assetPath(id, false)} 1x, ${assetPath(id, true)} ${a.hiDpi.scale}x`;
    },
    fonts,
    warnings,
  };

  // Scale mode: every length is `n * var(--u)`, with --u defined on each root.
  const build = (root: ExportNode): El => {
    const el = buildRoot(root, ctx);
    if (options.layout === 'scale') el.decls = { '--u': `calc(100vw / ${Math.round(root.width)})`, ...el.decls };
    return el;
  };

  // Group roots: breakpoint frames merge into one page; others stand alone.
  const groups: Group[] = [];
  let report: MatchReport | undefined;
  const bps = (input.breakpoints ?? [])
    .filter((b) => bundle.roots.some((r) => r.id === b.rootId))
    .sort((a, b) => a.minWidth - b.minWidth);
  const inBp = new Set<string>();
  if (bps.length >= 2) {
    const roots = bps.map((b) => bundle.roots.find((r) => r.id === b.rootId)!);
    roots.forEach((r) => inBp.add(r.id));
    const merged = mergeTrees(roots.map(build));
    report = merged.report;
    groups.push({ tree: merged.tree, widths: bps.map((b, i) => (i === 0 ? 0 : b.minWidth)), root: roots[0] });
  }
  for (const r of bundle.roots) {
    if (inBp.has(r.id)) continue;
    groups.push({ tree: mergeTrees([build(r)]).tree, widths: [0], root: r });
  }

  const namer = new ClassNamer();
  groups.forEach((g) => namer.assign(g.tree));

  let cssMode = options.cssMode;
  if (cssMode === 'inline' && groups.some((g) => g.widths.length > 1)) {
    cssMode = 'style-tag';
    warnings.push({ message: 'Inline styles cannot express breakpoints; used a <style> block instead.' });
  }

  /* ---- per-element styling (classes / tailwind / inline) ---- */

  let elements = 0;
  const styleOf = new Map<MEl, { className?: string; style?: Decls }>();
  const rules = new Map<string, Decls[]>();
  const walk = (m: MEl, widths: number[]) => {
    const el = firstSlot(m);
    if (el.kind !== 'TEXTNODE') {
      elements++;
      const deltas = cascade(m);
      if (isTw) {
        const classes: string[] = [];
        const style: Decls = {};
        deltas.forEach((d, i) => {
          const plain: Decls = {};
          for (const [k, v] of Object.entries(d)) {
            if (/url\(/.test(v)) {
              if (i === 0) style[k] = v;
              else warnings.push({ nodeId: el.node?.id, message: 'Background images that change per breakpoint are kept at the base value.' });
            } else plain[k] = v;
          }
          classes.push(...toTailwind(plain, i === 0 ? '' : `min-[${widths[i]}px]:`));
        });
        styleOf.set(m, { className: classes.join(' ') || undefined, style: Object.keys(style).length ? style : undefined });
      } else if (cssMode === 'inline') {
        styleOf.set(m, { style: Object.keys(deltas[0]).length ? deltas[0] : undefined });
      } else if (m.cls) {
        styleOf.set(m, { className: m.cls });
        if (!rules.has(m.cls)) rules.set(m.cls, deltas);
      }
    }
    m.children.forEach((c) => walk(c, widths));
  };
  groups.forEach((g) => walk(g.tree, g.widths));

  /* ---- CSS ---- */

  const cssParts: string[] = [];
  if (!isTw) cssParts.push(RESET);
  else cssParts.push('body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }');
  const vars = Object.entries(bundle.variables);
  if (options.useVariables && vars.length) cssParts.push(`:root {\n${vars.map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`);
  if (options.layout === 'scale') cssParts.push('body { overflow-x: hidden; }');
  const bodyBg = groups[0]?.root.fills[0];
  if (options.layout === 'fluid' && bodyBg?.type === 'SOLID') {
    const c = bodyBg.color;
    cssParts.push(`body { background: rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}); }`);
  }
  if (!isTw && cssMode !== 'inline') {
    const rule = (cls: string, d: Decls, indent = '') =>
      `${indent}.${cls} {\n${Object.entries(d)
        .map(([k, v]) => `${indent}  ${k}: ${v};`)
        .join('\n')}\n${indent}}`;
    for (const [cls, deltas] of rules) if (Object.keys(deltas[0]).length) cssParts.push(rule(cls, deltas[0]));
    const widths = [...new Set(groups.flatMap((g) => g.widths.slice(1)))].sort((a, b) => a - b);
    for (const w of widths) {
      const inner: string[] = [];
      for (const g of groups) {
        const i = g.widths.indexOf(w);
        if (i < 1) continue;
        const seen = new Set<string>();
        const visit = (m: MEl) => {
          if (m.cls && !seen.has(m.cls)) {
            seen.add(m.cls);
            const d = rules.get(m.cls)?.[i];
            if (d && Object.keys(d).length) inner.push(rule(m.cls, d, '  '));
          }
          m.children.forEach(visit);
        };
        visit(g.tree);
      }
      if (inner.length) cssParts.push(`@media (min-width: ${w}px) {\n${inner.join('\n')}\n}`);
    }
  }
  const css = cssParts.join('\n\n') + '\n';

  /* ---- fonts ---- */

  for (const family of fonts.keys()) {
    if (!isGoogleFont(family) && !isSystemFont(family))
      warnings.push({ message: `Font "${family}" is not on Google Fonts — self-host it or it will fall back.` });
  }
  const fontHref = googleFontsHref(fonts);

  /* ---- markup ---- */

  const emit = (jsx: boolean) => {
    const attrStr = (m: MEl, el: El): string => {
      const s = styleOf.get(m);
      const parts: string[] = [];
      if (s?.className)
        parts.push(
          jsx
            ? /["{}]/.test(s.className)
              ? `className={${JSON.stringify(s.className)}}`
              : `className="${s.className}"`
            : `class="${escapeAttr(s.className)}"`,
        );
      if (s?.style) parts.push(jsx ? `style=${styleObject(s.style)}` : `style="${escapeAttr(declsToString(s.style))}"`);
      for (const [k, v] of Object.entries(el.attrs)) parts.push(`${jsx ? (JSX_ATTR[k] ?? k) : k}="${escapeAttr(v)}"`);
      return parts.length ? ' ' + parts.join(' ') : '';
    };
    const inline = (m: MEl): string => {
      const el = firstSlot(m);
      if (el.kind === 'TEXTNODE') return jsx ? jsxText(el.text ?? '') : escapeHtml(el.text ?? '');
      const body = el.text != null ? (jsx ? jsxText(el.text) : escapeHtml(el.text)) : m.children.map(inline).join('');
      return `<${el.tag}${attrStr(m, el)}>${body}</${el.tag}>`;
    };
    const block = (m: MEl, depth: number): string => {
      const pad = '  '.repeat(depth);
      const el = firstSlot(m);
      if (el.kind === 'TEXT' || el.kind === 'SPAN' || el.kind === 'TEXTNODE') return pad + inline(m);
      if (el.kind === 'SVG') {
        const raw = el.raw ?? '';
        const svg = raw.replace(/^<svg/, `<svg${attrStr(m, el)}`);
        return pad + (jsx ? svgToJsx(svg) : svg).replace(/\n/g, `\n${pad}`);
      }
      if (el.tag === 'img') return `${pad}<img${attrStr(m, el)}${jsx ? ' />' : '>'}`;
      if (!m.children.length) return `${pad}<${el.tag}${attrStr(m, el)}></${el.tag}>`;
      return `${pad}<${el.tag}${attrStr(m, el)}>\n${m.children.map((c) => block(c, depth + 1)).join('\n')}\n${pad}</${el.tag}>`;
    };
    return (depth: number) => groups.map((g) => block(g.tree, depth)).join('\n');
  };
  const htmlBody = emit(false);
  const jsxBody = emit(true);

  const head = (cssLink: 'inline' | 'file' | 'none', extraCss = css) => {
    const lines = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(title)}</title>`,
    ];
    if (fontHref) {
      lines.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
      lines.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
      lines.push(`<link rel="stylesheet" href="${escapeAttr(fontHref)}">`);
    }
    if (isTw) lines.push(`<script src="${TAILWIND_CDN}"></script>`);
    if (cssLink === 'file') lines.push('<link rel="stylesheet" href="styles.css">');
    else if (cssLink === 'inline' && extraCss.trim()) lines.push(`<style>\n${extraCss}</style>`);
    return lines.map((l) => `  ${l}`).join('\n');
  };
  const doc = (cssLink: 'inline' | 'file' | 'none') =>
    `<!doctype html>\n<html lang="en">\n<head>\n${head(cssLink)}\n</head>\n<body>\n${htmlBody(1)}\n</body>\n</html>\n`;

  const document = doc('inline');

  /* ---- tabs & files ---- */

  const compName = pascal(title);
  const parts: GenerateResult['parts'] = {
    markup: htmlBody(0),
    css: cssParts.filter((p) => p !== RESET).join('\n\n') + '\n',
  };
  const tabs: CodeTab[] = [];
  const files: ZipEntry[] = [];
  const pushAssets = (dir: string) => {
    if (embed) return;
    for (const id of usedAssets) {
      const a = assets.get(id)!;
      files.push({ path: dir + assetPath(id, false).replace(/^\/?assets\//, 'assets/'), content: a.bytes });
      if (a.hiDpi) files.push({ path: dir + assetPath(id, true).replace(/^\/?assets\//, 'assets/'), content: a.hiDpi.bytes });
    }
  };

  if (!isReact) {
    const external = !isTw && cssMode === 'external';
    const indexHtml = doc(external ? 'file' : 'inline');
    tabs.push({ label: 'HTML', lang: 'html', content: indexHtml });
    if (!isTw && cssMode !== 'inline') tabs.push({ label: 'CSS', lang: 'css', content: css });
    files.push({ path: 'index.html', content: indexHtml });
    if (external) files.push({ path: 'styles.css', content: css });
    pushAssets('');
  } else {
    const jsx = `${isTw ? '' : "import './styles.css';\n\n"}export default function ${compName}() {\n  return (\n${
      groups.length > 1 ? `    <>\n${jsxBody(3)}\n    </>` : jsxBody(2)
    }\n  );\n}\n`;
    tabs.push({ label: `${compName}.jsx`, lang: 'jsx', content: jsx });
    parts.jsx = jsx;
    const reactCss = isTw ? cssParts.filter((p) => p !== RESET).join('\n\n') + '\n' : css;
    if (!isTw) tabs.push({ label: 'styles.css', lang: 'css', content: css });
    const fontLinks = fontHref
      ? `    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link rel="stylesheet" href="${escapeAttr(fontHref)}">\n`
      : '';
    files.push(
      {
        path: 'package.json',
        content:
          JSON.stringify(
            {
              name: compName.replace(/[A-Z]/g, (c, i) => (i ? '-' : '') + c.toLowerCase()),
              private: true,
              version: '0.0.0',
              type: 'module',
              scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
              dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
              devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' },
            },
            null,
            2,
          ) + '\n',
      },
      {
        path: 'vite.config.js',
        content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n",
      },
      {
        path: 'index.html',
        content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1">\n    <title>${escapeHtml(title)}</title>\n${fontLinks}${
          isTw ? `    <script src="${TAILWIND_CDN}"></script>\n` : ''
        }  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
      },
      {
        path: 'src/main.jsx',
        content: `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport ${compName} from './${compName}.jsx';\n${
          isTw && reactCss.trim() ? "import './styles.css';\n" : ''
        }\ncreateRoot(document.getElementById('root')).render(\n  <StrictMode>\n    <${compName} />\n  </StrictMode>,\n);\n`,
      },
      { path: `src/${compName}.jsx`, content: jsx },
    );
    if (!isTw || reactCss.trim()) files.push({ path: 'src/styles.css', content: isTw ? reactCss : css });
    files.push({
      path: 'README.md',
      content: `# ${title}\n\nExported from Figma with agioDesign.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n${
        isTw ? '\nTailwind is loaded from its CDN for a zero-config start; install `tailwindcss` for production builds.\n' : ''
      }`,
    });
    pushAssets('public/');
  }

  return {
    document,
    tabs,
    files,
    warnings,
    report,
    stats: { elements, classes: rules.size },
    parts,
  };
}
