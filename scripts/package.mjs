#!/usr/bin/env node
/**
 * Builds a shareable, source-free package of agioDesign:
 *
 *   release/agioDesign-v<version>.zip
 *     agioDesign/                  ← import manifest.json in Figma desktop
 *       manifest.json, dist/code.js, dist/ui.html   (minified)
 *     Bridge (optional)/
 *       macOS/  agioDesign Bridge (Apple Silicon|Intel), Uninstall….command
 *       Windows/agioDesign Bridge.exe, Uninstall….cmd
 *     HUONG-DAN.txt, THIRD-PARTY-NOTICES.txt
 *
 * The bridge is compiled with bun into one self-contained executable per OS,
 * so recipients need neither Node.js nor the .mjs sources.
 *
 *   npm run package                      # plugin + bridge (macOS arm64/x64, Windows x64)
 *   npm run package -- --no-bridge       # plugin only
 *   AGIO_TARGETS=bun-linux-x64 npm run package   # choose bridge targets
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.chdir(root);

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = `agioDesign-v${version}`;
const outRoot = path.join(root, 'release');
const out = path.join(outRoot, name);
const withBridge = !process.argv.includes('--no-bridge');
const targets = (process.env.AGIO_TARGETS || 'bun-darwin-arm64,bun-darwin-x64,bun-windows-x64')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/* 1. Minified plugin build. */
console.log('› building plugin (release)…');
run(process.execPath, ['build.mjs', '--release']);

/* 2. Refuse to ship anything that looks like a secret or a local path. */
const SECRET = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic API key'],
  [/sk-(proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI API key'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'your home folder path'],
];
for (const f of ['dist/code.js', 'dist/ui.html']) {
  const text = fs.readFileSync(f, 'utf8');
  for (const [re, what] of SECRET) {
    if (re.test(text)) throw new Error(`${f} contains ${what} — not packaging.`);
  }
}

/* 3. Assemble. */
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const plugin = path.join(out, 'agioDesign');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
write(path.join(plugin, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
for (const f of ['code.js', 'ui.html']) fs.copyFileSync(path.join('dist', f), path.join(plugin, 'dist', f));

const BIN_NAMES = {
  'bun-darwin-arm64': ['macOS', 'agioDesign Bridge (Apple Silicon)'],
  'bun-darwin-x64': ['macOS', 'agioDesign Bridge (Intel)'],
  'bun-windows-x64': ['Windows', 'agioDesign Bridge.exe'],
  'bun-linux-x64': ['Linux', 'agiodesign-bridge'],
  'bun-linux-arm64': ['Linux', 'agiodesign-bridge-arm64'],
};

if (withBridge) {
  const bridgeDir = path.join(out, 'Bridge (optional)');
  const oses = new Set();
  for (const target of targets) {
    const entry = BIN_NAMES[target];
    if (!entry) throw new Error(`Unknown bridge target "${target}" (known: ${Object.keys(BIN_NAMES).join(', ')})`);
    const [osName, file] = entry;
    const dest = path.join(bridgeDir, osName, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    console.log(`› compiling bridge for ${target}…`);
    run('npx', ['--yes', 'bun@1', 'build', 'bridge/cli.mjs', '--compile', '--minify', `--target=${target}`, `--outfile=${dest}`]);
    // bun appends .exe itself for Windows targets when missing.
    if (osName !== 'Windows') fs.chmodSync(dest, 0o755);
    // Ad-hoc signature: required for arm64 macOS and keeps Gatekeeper's prompt to "Open Anyway".
    if (osName === 'macOS' && process.platform === 'darwin') {
      spawnSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'ignore' });
    }
    oses.add(osName);
  }
  if (oses.has('macOS')) {
    write(
      path.join(bridgeDir, 'macOS', 'Uninstall agioDesign Bridge.command'),
      '#!/bin/sh\n# Removes the agioDesign bridge login item and stops it.\n"$HOME/.agiodesign-bridge/bin/agiodesign-bridge" uninstall\n',
      0o755,
    );
  }
  if (oses.has('Windows')) {
    write(
      path.join(bridgeDir, 'Windows', 'Uninstall agioDesign Bridge.cmd'),
      '@echo off\r\nrem Removes the agioDesign bridge login item and stops it.\r\n"%USERPROFILE%\\.agiodesign-bridge\\bin\\agiodesign-bridge.exe" uninstall\r\n',
    );
  }
  if (oses.has('Linux')) {
    write(
      path.join(bridgeDir, 'Linux', 'uninstall.sh'),
      '#!/bin/sh\n"$HOME/.agiodesign-bridge/bin/agiodesign-bridge" uninstall\n',
      0o755,
    );
  }
}

/* 4. Docs. */
write(
  path.join(out, 'HUONG-DAN.txt'),
  `agioDesign v${version} — Hướng dẫn cài đặt
============================================

agioDesign là plugin Figma:
  • Design: chuyển HTML/CSS, URL, file .html thành layer Figma chỉnh sửa được.
  • Code: xuất frame Figma ra HTML/CSS, Tailwind, React (có responsive).
  • AI: tạo giao diện bằng prompt (Claude, GPT, Gemini…).

Yêu cầu: ứng dụng Figma DESKTOP (bản web không import được plugin dạng này).


1) CÀI PLUGIN
-------------
  1. Giải nén file zip vào một thư mục cố định (đừng để trong Downloads rồi xoá).
  2. Mở Figma desktop → mở một file design bất kỳ.
  3. Menu Plugins → Development → Import plugin from manifest…
  4. Chọn file  agioDesign/manifest.json
  5. Chạy: Plugins → Development → agioDesign

  Cập nhật phiên bản mới: giải nén đè lên đúng thư mục cũ, không cần import lại.


2) DÙNG AI (tuỳ chọn)
---------------------
  Tab AI → Settings → chọn nhà cung cấp và dán API key của BẠN
  (Anthropic / OpenAI / Google). Key chỉ lưu trong Figma trên máy bạn.


3) BRIDGE (tuỳ chọn — chỉ cần nếu muốn dùng Claude Code / Codex CLI đã cài
   trên máy thay cho API key, hoặc tìm kiếm web)
--------------------------------------------------------------------------
  macOS:
    • Mở thư mục  Bridge (optional)/macOS
    • Máy Apple Silicon (M1/M2/M3/M4): chuột phải "agioDesign Bridge (Apple Silicon)" → Open
      Máy Intel: dùng file "(Intel)".
    • Lần đầu macOS sẽ chặn vì app chưa ký bởi Apple: bấm Done, rồi vào
      System Settings → Privacy & Security → kéo xuống → "Open Anyway".
    • Cửa sổ Terminal hiện "✓ Bridge installed" là xong. Bridge tự chạy mỗi lần đăng nhập.

  Windows:
    • Mở  Bridge (optional)\\Windows  → chạy "agioDesign Bridge.exe".
    • Nếu SmartScreen cảnh báo: More info → Run anyway.

  Sau đó trong plugin: tab AI → Bridge → Connect → bấm Allow ở hộp thoại hiện ra.

  Gỡ bridge: chạy file "Uninstall agioDesign Bridge" trong cùng thư mục.
  Dữ liệu bridge nằm ở thư mục  ~/.agiodesign-bridge  (xoá để reset hoàn toàn).


Lưu ý: bản này để dùng cá nhân, vui lòng không chia sẻ lại khi chưa hỏi tác giả.
`,
);

const license = (pkg) => {
  for (const f of ['LICENSE', 'LICENSE.md', 'license']) {
    const p = path.join('node_modules', pkg, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  return '(license file not found)';
};
write(
  path.join(out, 'THIRD-PARTY-NOTICES.txt'),
  `agioDesign bundles the following open-source software.\n\n${['react', 'react-dom', 'scheduler']
    .map((p) => `=== ${p} ===\n${license(p)}`)
    .join('\n\n')}\n${
    withBridge
      ? `\n=== Bun runtime (bridge executables) ===\nThe bridge executables embed the Bun runtime (MIT, https://github.com/oven-sh/bun), which includes\nWebKit JavaScriptCore (LGPL-2.1). Source: https://github.com/oven-sh/WebKit\n`
      : ''
  }`,
);

/* 5. Zip (system zip keeps the executable bit the macOS bridge needs). */
const zipPath = path.join(outRoot, `${name}.zip`);
fs.rmSync(zipPath, { force: true });
run('zip', ['-r', '-y', '-9', '-q', `${name}.zip`, name, '-x', '*.DS_Store'], { cwd: outRoot });

const size = (p) => `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`\n✓ ${path.relative(root, zipPath)}  (${size(zipPath)})`);
console.log('  Contents: agioDesign/ (plugin)' + (withBridge ? `, Bridge (optional)/ [${targets.join(', ')}]` : '') + ', HUONG-DAN.txt');
