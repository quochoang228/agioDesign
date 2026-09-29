#!/usr/bin/env node
/**
 * One-time installer for the local bridge: registers it to start at login and
 * starts it now, so users never need a terminal again — the plugin turns it
 * on/off and pairs with it. Usually launched by double-clicking one of the
 * "Install Bridge (…)" wrappers next to this file.
 *
 *   node bridge/install.mjs install | uninstall | status
 *
 *   macOS   → ~/Library/LaunchAgents/com.htmltofigma.bridge.plist (launchd)
 *   Windows → Startup folder\HTML to Figma Bridge.vbs (hidden window)
 *   Linux   → ~/.config/autostart/html-to-figma-bridge.desktop (XDG, desktop sessions)
 *
 * The login item points at this folder in place — re-run install if the plugin
 * folder moves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DATA_DIR, PID_FILE, LOG_FILE } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const NODE = process.execPath;
const HEALTH = `http://127.0.0.1:${DEFAULT_PORT}/health`;

const MAC_LABEL = 'com.htmltofigma.bridge';
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
const WIN_VBS = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'HTML to Figma Bridge.vbs',
);
const LINUX_DESKTOP = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autostart', 'html-to-figma-bridge.desktop',
);
const LINUX_START = path.join(DATA_DIR, 'start.sh');

/**
 * PATH for the login item. Login items get a minimal PATH, which would hide
 * CLIs installed via Homebrew, npm -g or ~/.local/bin — so capture the PATH of
 * the shell running the installer plus the usual install locations.
 */
function capturedPath() {
  const extra =
    process.platform === 'win32'
      ? []
      : [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const parts = [...(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shEsc = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const vbsEsc = (s) => s.replace(/"/g, '""');

async function health() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(up, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!!(await health()) === up) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Stop whatever bridge currently holds the port (e.g. one from `npm run bridge`). */
async function stopRunning() {
  const pids = new Set();
  const h = await health();
  if (h?.pid) pids.add(h.pid);
  try {
    pids.add(Number(fs.readFileSync(PID_FILE, 'utf8').trim()));
  } catch {
    /* no pid file */
  }
  for (const pid of pids) {
    try {
      if (pid) process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  if (!(await waitFor(false, 5000))) {
    throw new Error(`Something else is using port ${DEFAULT_PORT}. Close it and run the installer again.`);
  }
}

// ---- per-platform ----

const mac = {
  installed: () => fs.existsSync(MAC_PLIST),
  install() {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEsc(NODE)}</string><string>${xmlEsc(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEsc(here)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xmlEsc(capturedPath())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xmlEsc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(LOG_FILE)}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
    fs.writeFileSync(MAC_PLIST, plist);
    const domain = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', `${domain}/${MAC_LABEL}`], { stdio: 'ignore' });
    const r = spawnSync('launchctl', ['bootstrap', domain, MAC_PLIST], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr || r.status}`);
  },
  uninstall() {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${MAC_LABEL}`], { stdio: 'ignore' });
    fs.rmSync(MAC_PLIST, { force: true });
  },
};

const win = {
  installed: () => fs.existsSync(WIN_VBS),
  install() {
    // cmd /c ""node" "server" >> "log" 2>&1" — outer quotes are stripped by cmd.
    const cmd = `cmd /c ""${NODE}" "${SERVER}" >> "${LOG_FILE}" 2>&1"`;
    const vbs = `' Starts the HTML to Figma bridge at login (hidden window).\r\nCreateObject("WScript.Shell").Run "${vbsEsc(cmd)}", 0, False\r\n`;
    fs.mkdirSync(path.dirname(WIN_VBS), { recursive: true });
    fs.writeFileSync(WIN_VBS, vbs);
    spawn('wscript.exe', [WIN_VBS], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  },
  uninstall() {
    fs.rmSync(WIN_VBS, { force: true });
  },
};

const linux = {
  installed: () => fs.existsSync(LINUX_DESKTOP),
  install() {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      LINUX_START,
      `#!/bin/sh\n# Starts the HTML to Figma bridge (written by install.mjs).\nPATH=${shEsc(capturedPath())}\nexport PATH\nexec ${shEsc(NODE)} ${shEsc(SERVER)} >> ${shEsc(LOG_FILE)} 2>&1\n`,
      { mode: 0o755 },
    );
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=HTML to Figma Bridge',
      'Comment=Local bridge for the HTML to Figma Pro plugin',
      `Exec=/bin/sh "${LINUX_START.replace(/(["`$\\])/g, '\\$1')}"`,
      'NoDisplay=true',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(LINUX_DESKTOP), { recursive: true });
    fs.writeFileSync(LINUX_DESKTOP, desktop);
    spawn('/bin/sh', [LINUX_START], { detached: true, stdio: 'ignore' }).unref();
  },
  uninstall() {
    fs.rmSync(LINUX_DESKTOP, { force: true });
    fs.rmSync(LINUX_START, { force: true });
  },
};

const platform = process.platform === 'darwin' ? mac : process.platform === 'win32' ? win : linux;

// ---- commands ----

async function install() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) throw new Error(`Node.js 18 or newer is required (found ${process.versions.node}). Get it from https://nodejs.org`);
  await stopRunning();
  platform.install();
  const up = (await waitFor(true)) && (await health());
  if (!up || typeof up.enabled !== 'boolean') {
    throw new Error(`Installed, but the bridge didn't answer on port ${DEFAULT_PORT}. See ${LOG_FILE}`);
  }
  console.log('✓ Bridge installed — it now starts automatically when you log in.');
  console.log('');
  console.log('Next: open the plugin in Figma → AI tab → Bridge → Connect, then click Allow.');
  console.log(`(If you move this plugin folder, run the installer again.)`);
}

async function uninstall() {
  platform.uninstall();
  await stopRunning();
  console.log('✓ Bridge removed. It will no longer start at login.');
  console.log(`(Your pairing token is kept in ${DATA_DIR}; delete that folder to reset it.)`);
}

async function status() {
  const h = await health();
  console.log(`login item : ${platform.installed() ? 'installed' : 'not installed'}`);
  console.log(`running    : ${h ? 'yes' : 'no'}`);
  if (h) console.log(`switch     : ${h.enabled ? 'on' : 'off'}`);
}

const cmd = process.argv[2] || 'install';
const run = { install, uninstall, status }[cmd];
if (!run) {
  console.error('usage: node bridge/install.mjs install | uninstall | status');
  process.exit(2);
}
run().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
