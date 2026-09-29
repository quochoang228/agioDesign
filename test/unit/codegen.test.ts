import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExportBundle, ExportFrame, ExportNode, ExportOptions, ExportText, TextRun } from '../../src/shared/export';
import { DEFAULT_EXPORT_OPTIONS } from '../../src/shared/export';
import { generate } from '../../src/codegen';
import { base64, cssColor, makeUnits, slugify } from '../../src/codegen/css';
import { linearGradient } from '../../src/codegen/paint';
import { toTailwind } from '../../src/codegen/tailwind';
import { zip, utf8 } from '../../src/codegen/zip';

/* ---------- fixture helpers ---------- */

let seq = 0;
const base = (over: Partial<ExportFrame> = {}) => ({
  id: `1:${++seq}`,
  name: 'Frame',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  opacity: 1,
  absolute: false,
  sizingH: 'FIXED' as const,
  sizingV: 'FIXED' as const,
  constraints: { h: 'MIN' as const, v: 'MIN' as const },
  fills: [],
  effects: [],
  ...over,
});

function frame(over: Partial<ExportFrame> = {}, children: ExportNode[] = []): ExportFrame {
  return { ...base(over), kind: 'FRAME', clips: false, children, ...over, id: over.id ?? `1:${++seq}` } as ExportFrame;
}

const run = (start: number, end: number, over: Partial<TextRun> = {}): TextRun => ({
  start,
  end,
  fontFamily: 'Inter',
  fontWeight: 400,
  italic: false,
  fontSize: 16,
  lineHeight: { unit: 'AUTO', value: 0 },
  letterSpacing: { unit: 'PX', value: 0 },
  fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
  decoration: 'NONE',
  textCase: 'ORIGINAL',
  ...over,
});

function text(characters: string, over: Partial<ExportText> = {}): ExportText {
  return {
    ...base(),
    kind: 'TEXT',
    name: characters,
    characters,
    runs: [run(0, characters.length)],
    alignH: 'LEFT',
    alignV: 'TOP',
    autoResize: 'WIDTH_AND_HEIGHT',
    sizingH: 'HUG',
    sizingV: 'HUG',
    ...over,
  } as ExportText;
}

const bundle = (roots: ExportNode[], extra: Partial<ExportBundle> = {}): ExportBundle => ({
  roots,
  assets: [],
  warnings: [],
  variables: {},
  ...extra,
});

const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...o });

const css = (r: ReturnType<typeof generate>) => r.tabs.find((t) => t.lang === 'css')?.content ?? '';

/* ---------- helpers ---------- */

test('cssColor, slugify, base64', () => {
  assert.equal(cssColor({ r: 1, g: 0, b: 0, a: 1 }), '#ff0000');
  assert.equal(cssColor({ r: 0, g: 0, b: 0, a: 0.5 }), 'rgba(0, 0, 0, 0.5)');
  assert.equal(slugify('Nút Đăng ký / Primary'), 'nut-dang-ky-primary');
  for (const s of ['', 'a', 'ab', 'abc', 'hello world!']) {
    assert.equal(base64(utf8(s)), Buffer.from(s).toString('base64'));
  }
});

test('units: px, rem and scale', () => {
  assert.equal(makeUnits({ layout: 'fixed', units: 'px' }).len(12), '12px');
  assert.equal(makeUnits({ layout: 'fluid', units: 'rem' }).len(24), '1.5rem');
  assert.equal(makeUnits({ layout: 'scale', units: 'rem' }).len(10), 'calc(10 * var(--u))');
});

test('linear gradient angles follow the Figma handles', () => {
  const stops = [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ];
  // Identity: left → right.
  assert.equal(linearGradient([[1, 0, 0], [0, 1, 0]], stops, 100, 100, 1, false), 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
  // Rotated 90°: top → bottom.
  assert.equal(linearGradient([[0, 1, 0], [-1, 0, 1]], stops, 100, 100, 1, false), 'linear-gradient(180deg, #ff0000 0%, #0000ff 100%)');
});

/* ---------- generation ---------- */

test('auto layout frame → flexbox with gap, padding and alignment', () => {
  const root = frame(
    {
      name: 'Card',
      width: 320,
      height: 200,
      layout: { direction: 'COLUMN', wrap: false, gap: 12, crossGap: 0, padding: [24, 24, 24, 24], justify: 'MIN', align: 'CENTER' },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      radius: [16, 16, 16, 16],
    },
    [text('Hello')],
  );
  const r = generate({ bundle: bundle([root]), options: opts({ layout: 'fixed' }), target: 'preview' });
  const c = css(r);
  assert.match(c, /\.card \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 12px;[^}]*padding: 24px;[^}]*align-items: center;/s);
  assert.match(c, /border-radius: 16px;/);
  assert.match(c, /background: #ffffff;/);
  assert.match(r.document, /<div class="card">\s*<p class="hello">Hello<\/p>\s*<\/div>/);
  assert.match(r.document, /fonts\.googleapis\.com\/css2\?family=Inter:wght@400/);
});

test('fixed-size children in flex keep flex-shrink:0 in fixed mode only', () => {
  const child = frame({ name: 'Box', width: 40, height: 40 });
  const root = frame(
    { name: 'Row', layout: { direction: 'ROW', wrap: false, gap: 0, crossGap: 0, padding: [0, 0, 0, 0], justify: 'SPACE_BETWEEN', align: 'MIN' } },
    [child],
  );
  const fixed = css(generate({ bundle: bundle([root]), options: opts({ layout: 'fixed' }), target: 'preview' }));
  assert.match(fixed, /\.box \{[^}]*width: 40px;[^}]*flex-shrink: 0;/s);
  assert.match(fixed, /justify-content: space-between/);
  const fluid = css(generate({ bundle: bundle([root]), options: opts({ layout: 'fluid' }), target: 'preview' }));
  assert.doesNotMatch(fluid, /flex-shrink/);
});

test('absolute children honour constraints in fluid mode', () => {
  const pinned = frame({ name: 'Badge', x: 260, y: 10, width: 30, height: 20, absolute: true, constraints: { h: 'MAX', v: 'MIN' } });
  const stretched = frame({ name: 'Bar', x: 10, y: 50, width: 280, height: 4, absolute: true, constraints: { h: 'STRETCH', v: 'MIN' } });
  const root = frame({ name: 'Canvas', width: 300, height: 100 }, [pinned, stretched]);
  const c = css(generate({ bundle: bundle([root]), options: opts({ layout: 'fluid' }), target: 'preview' }));
  assert.match(c, /\.badge \{[^}]*position: absolute;[^}]*right: 10px;[^}]*width: 30px;/s);
  assert.match(c, /\.bar \{[^}]*left: 10px;[^}]*right: 10px;/s);
  assert.match(c, /\.canvas \{[^}]*position: relative;[^}]*width: 100%;[^}]*max-width: 300px;/s);
});

test('scale mode defines --u on the root and scales every length', () => {
  const root = frame({ name: 'Hero', width: 1440, height: 800 }, [frame({ name: 'Box', x: 144, y: 0, width: 720, height: 80, absolute: true })]);
  const c = css(generate({ bundle: bundle([root]), options: opts({ layout: 'scale' }), target: 'preview' }));
  assert.match(c, /--u: calc\(100vw \/ 1440\)/);
  assert.match(c, /\.box \{[^}]*left: calc\(144 \* var\(--u\)\);[^}]*width: calc\(720 \* var\(--u\)\);/s);
});

test('mixed text runs become spans; links become anchors', () => {
  const t = text('Hello bold link', {
    runs: [run(0, 6), run(6, 10, { fontWeight: 700 }), run(10, 15, { link: 'https://x.dev' })],
  });
  const r = generate({ bundle: bundle([frame({ name: 'Wrap' }, [t])]), options: opts(), target: 'preview' });
  assert.match(r.document, /<p class="hello-bold-link">Hello <span class="hello-bold-link-1">bold<\/span><a href="https:\/\/x.dev"> link<\/a><\/p>/);
  assert.match(css(r), /\.hello-bold-link-1 \{\s*font-weight: 700;\s*\}/);
});

test('semantic tags come from layer names; nested buttons are avoided', () => {
  const inner = frame({ name: 'Button' });
  const root = frame({ name: 'Primary button' }, [inner]);
  const r = generate({ bundle: bundle([root]), options: opts(), target: 'preview' });
  assert.match(r.document, /<button class="primary-button">\s*<div class="button"><\/div>/);
  const off = generate({ bundle: bundle([root]), options: opts({ semanticTags: false }), target: 'preview' });
  assert.doesNotMatch(off.document, /<button/);
});

test('identical styles share a class', () => {
  const a = frame({ name: 'Dot', width: 8, height: 8, absolute: true });
  const b = frame({ name: 'Dot', width: 8, height: 8, absolute: true });
  const r = generate({ bundle: bundle([frame({ name: 'Dots' }, [a, b])]), options: opts({ layout: 'fixed' }), target: 'preview' });
  assert.equal((r.document.match(/class="dot"/g) ?? []).length, 2);
  assert.equal(r.stats.classes, 2);
});

test('variables become CSS custom properties with fallbacks', () => {
  const root = frame({ name: 'Tok', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, variable: 'color-primary' }] });
  const r = generate({ bundle: bundle([root], { variables: { 'color-primary': '#0000ff' } }), options: opts(), target: 'preview' });
  assert.match(css(r), /--color-primary: #0000ff;/);
  assert.match(css(r), /background: var\(--color-primary, #0000ff\);/);
});

test('breakpoints merge frames into one page with media queries', () => {
  const al = (dir: 'ROW' | 'COLUMN') => ({ direction: dir, wrap: false, gap: 16, crossGap: 0, padding: [0, 0, 0, 0] as [number, number, number, number], justify: 'MIN' as const, align: 'MIN' as const });
  const mobile = frame({ id: 'm', name: 'Page', width: 390, height: 800, layout: al('COLUMN') }, [
    text('Title', { id: 'm1' }),
    frame({ id: 'm2', name: 'Menu', width: 390, height: 40 }),
  ]);
  const desktop = frame({ id: 'd', name: 'Page', width: 1440, height: 900, layout: al('ROW') }, [
    text('Title', { id: 'd1' }),
    frame({ id: 'd2', name: 'Sidebar', width: 300, height: 900 }),
  ]);
  const r = generate({
    bundle: bundle([mobile, desktop]),
    options: opts({ layout: 'fluid' }),
    breakpoints: [
      { rootId: 'd', minWidth: 1024 },
      { rootId: 'm', minWidth: 0 },
    ],
    target: 'preview',
  });
  const c = css(r);
  // One root element, title shared, menu/sidebar toggled.
  assert.equal((r.document.match(/class="page"/g) ?? []).length, 1);
  assert.equal((r.document.match(/>Title</g) ?? []).length, 1);
  assert.match(c, /@media \(min-width: 1024px\) \{[\s\S]*\.page \{[^}]*max-width: 1440px;[^}]*flex-direction: unset;/);
  assert.match(c, /\.sidebar \{[^}]*display: none;/);
  assert.match(c, /@media \(min-width: 1024px\) \{[\s\S]*\.menu \{\s*display: none;/);
  assert.deepEqual(r.report?.unmatched, [
    { name: 'Sidebar', breakpoint: 1 },
    { name: 'Menu', breakpoint: 0 },
  ]);
  assert.equal(r.report?.matched, 1);
});

test('tailwind output uses utilities, breakpoint variants and the CDN', () => {
  assert.deepEqual(toTailwind({ display: 'flex', 'flex-direction': 'column', gap: '12px', 'font-family': '"Open Sans", sans-serif' }), [
    'flex',
    'flex-col',
    'gap-[12px]',
    "[font-family:'Open_Sans',_sans-serif]",
  ]);
  const root = frame({ name: 'Box', layout: { direction: 'ROW', wrap: false, gap: 8, crossGap: 0, padding: [4, 4, 4, 4], justify: 'CENTER', align: 'CENTER' } });
  const r = generate({ bundle: bundle([root]), options: opts({ format: 'tailwind' }), target: 'preview' });
  assert.match(r.document, /cdn\.tailwindcss\.com/);
  assert.match(r.document, /class="[^"]*\bflex\b[^"]*\bjustify-center\b[^"]*\bitems-center\b/);
});

test('react output is a Vite starter with a JSX component', () => {
  const root = frame({ name: 'Login card' }, [text('Sign in')]);
  const r = generate({ bundle: bundle([root]), options: opts({ format: 'react' }), target: 'download' });
  const jsx = r.tabs[0].content;
  assert.match(jsx, /export default function LoginCard\(\)/);
  assert.match(jsx, /<div className="login-card">/);
  assert.match(jsx, /<p className="sign-in">Sign in<\/p>/);
  const paths = r.files.map((f) => f.path);
  for (const p of ['package.json', 'index.html', 'src/main.jsx', 'src/LoginCard.jsx', 'src/styles.css']) assert.ok(paths.includes(p), p);
});

test('image assets: embedded for preview, files with srcset for download', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const img = frame({ name: 'Hero photo', width: 200, height: 100, fills: [{ type: 'IMAGE', assetId: 'h1', scaleMode: 'FILL', opacity: 1 }] });
  const raster = { ...base({ name: 'Chart' }), kind: 'RASTER' as const, assetId: 'r1' };
  const b = bundle([frame({ name: 'Page' }, [img, raster])], {
    assets: [
      { id: 'h1', name: 'hero-photo', mime: 'image/png', bytes },
      { id: 'r1', name: 'chart', mime: 'image/png', bytes, hiDpi: { scale: 2, bytes } },
    ],
  });
  const preview = generate({ bundle: b, options: opts({ images: 'files' }), target: 'preview' });
  assert.match(preview.document, /<img class="hero-photo" src="data:image\/png;base64,/);
  const dl = generate({ bundle: b, options: opts({ images: 'files' }), target: 'download' });
  assert.match(dl.document, /src="assets\/chart.png" alt="Chart" srcset="assets\/chart.png 1x, assets\/chart@2x.png 2x"/);
  assert.deepEqual(dl.files.map((f) => f.path).sort(), ['assets/chart.png', 'assets/chart@2x.png', 'assets/hero-photo.png', 'index.html']);
});

test('zip writer produces a valid archive layout', () => {
  const out = zip([
    { path: 'a.txt', content: 'hello' },
    { path: 'dir/b.bin', content: new Uint8Array([1, 2, 3]) },
  ]);
  const v = new DataView(out.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const eocd = out.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  assert.equal(v.getUint16(eocd + 10, true), 2);
});

test('refine: data URIs are swapped for placeholders and restored', async () => {
  const { stripAssets, extractCode } = await import('../../src/ui/export/refine');
  const uri = 'data:image/png;base64,' + 'A'.repeat(200);
  const src = `<img src="${uri}"><div style="background:url(${uri})"></div>`;
  const { code, restore } = stripAssets(src);
  assert.equal(code, '<img src="__ASSET_1__"><div style="background:url(__ASSET_1__)"></div>');
  assert.equal(restore(code), src);
  assert.equal(extractCode('Sure!\n```html\n<p>x</p>\n```\nDone'), '<p>x</p>\n');
  assert.equal(extractCode('<p>raw</p>'), '<p>raw</p>\n');
});
