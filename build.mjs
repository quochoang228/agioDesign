import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
await mkdir(outdir, { recursive: true });

/** Bundle the sandbox (main thread) code — no DOM, runs in Figma's QuickJS. */
const codeCtx = await esbuild.context({
  entryPoints: ['src/main/code.ts'],
  bundle: true,
  outfile: `${outdir}/code.js`,
  target: 'es2017',
  format: 'iife',
  logLevel: 'info',
});

/** Bundle the React UI (runs in an <iframe> with full DOM access). */
const uiCtx = await esbuild.context({
  entryPoints: ['src/ui/main.tsx'],
  bundle: true,
  write: false,
  outfile: 'ui.js',
  target: 'es2018',
  format: 'iife',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

/** Inline the bundled JS + CSS into a single self-contained ui.html. */
async function emitUiHtml() {
  const result = await uiCtx.rebuild();
  const jsFile = result.outputFiles?.find((f) => f.path.endsWith('.js'));
  const js = jsFile?.text ?? '';
  if (!js) throw new Error('UI bundle produced no JS output');
  const css = await readFile('src/ui/styles.css', 'utf8');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js.replace(/<\/script>/gi, '<\\/script>')}</script>
</body>
</html>`;
  await writeFile(`${outdir}/ui.html`, html);
  console.log('  dist/ui.html  (inlined)');
}

if (watch) {
  await codeCtx.watch();
  await emitUiHtml();
  // Re-emit the inlined HTML whenever a UI source file changes.
  const { watch: fsWatch } = await import('node:fs');
  fsWatch('src/ui', { recursive: true }, () => emitUiHtml().catch(console.error));
  console.log('watching…');
} else {
  await codeCtx.rebuild();
  await emitUiHtml();
  await codeCtx.dispose();
  await uiCtx.dispose();
  console.log('build complete.');
}
