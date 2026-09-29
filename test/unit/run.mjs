/**
 * Unit-test runner: bundles each test/unit/*.test.{ts,mjs} with esbuild (so the
 * sources' extensionless TS imports resolve) and runs them with `node --test`.
 * No extra dependencies beyond the esbuild already used for the plugin build.
 */
import * as esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = 'test/unit';
const outdir = 'test/unit/.build';
const entries = readdirSync(dir)
  .filter((f) => /\.test\.(ts|mjs)$/.test(f))
  .map((f) => path.join(dir, f));

rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir,
  outExtension: { '.js': '.mjs' },
  packages: 'external',
  logLevel: 'warning',
});

const files = entries.map((e) => path.join(outdir, path.basename(e).replace(/\.(ts|mjs)$/, '.mjs')));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
