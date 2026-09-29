/** Bundles test/roundtrip.ts into a self-contained test/roundtrip.html. */
import * as esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';

const r = await esbuild.build({
  entryPoints: ['test/roundtrip.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  logLevel: 'warning',
});
const js = r.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
await writeFile(
  'test/roundtrip.html',
  `<!doctype html><html><head><meta charset=utf-8><title>Round trip</title><style>
body{margin:0;background:#1e1e1e;color:#ddd;font:12px system-ui}
#out{position:sticky;top:0;padding:6px 10px;background:#000;z-index:2}
.pane{margin:12px}.pane b{display:block;margin:4px 0}
iframe{display:block;border:0;background:#fff;height:1400px}
body[data-view=src] #p-gen,body[data-view=gen] #p-src{display:none}
</style></head><body><div id=out>running…</div>
<div class=pane id=p-src><b>Source HTML</b><iframe id=src></iframe></div>
<div class=pane id=p-gen><b>Regenerated from ExportNode</b><iframe id=gen></iframe></div>
<script>document.body.dataset.view=new URLSearchParams(location.search).get('view')||'both'</script>
<script>${js}</script></body></html>`,
);
console.log('test/roundtrip.html written');
