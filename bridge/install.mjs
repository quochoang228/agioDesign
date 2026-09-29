#!/usr/bin/env node
/**
 * One-time installer for the local bridge: registers it to start at login and
 * starts it now, so users never need a terminal again — the plugin turns it
 * on/off and pairs with it. Usually launched by double-clicking one of the
 * "Install Bridge (…)" wrappers next to this file.
 *
 *   node bridge/install.mjs install | uninstall | status
 *
 *   macOS   → ~/Library/LaunchAgents/com.agiodesign.bridge.plist (launchd)
 *   Windows → Startup folder\agioDesign Bridge.vbs (hidden window)
 *   Linux   → ~/.config/autostart/agiodesign-bridge.desktop (XDG, desktop sessions)
 *
 * Login items from before the rename (com.htmltofigma.bridge …) are removed on
 * install and uninstall.
 *
 * The login item points at this folder in place — re-run install if the plugin
 * folder moves.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, DATA_DIR, LEGACY_DATA_DIR, PID_FILE, LOG_FILE, IS_BINARY, BIN_PATH } from './paths.mjs';

const here = IS_BINARY ? DATA_DIR : path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const NODE = process.execPath;
/** What the login item runs: node + server.mjs, or the installed executable. */
const PROGRAM = IS_BINARY ? [BIN_PATH, 'serve'] : [NODE, SERVER];

/**
 * Packaged executable: copy it to a stable location so the login item keeps
 * working after the user deletes or moves the download.
 */
function installBinary() {
  if (!IS_BINARY || path.resolve(process.execPath) === path.resolve(BIN_PATH)) return;
  fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${BIN_PATH}.tmp`;
  fs.copyFileSync(process.execPath, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, BIN_PATH);
}
const HEALTH = `http://127.0.0.1:${DEFAULT_PORT}/health`;

const MAC_LABEL = 'com.agiodesign.bridge';
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const WIN_VBS = path.join(STARTUP_DIR, 'agioDesign Bridge.vbs');
const AUTOSTART_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
const LINUX_DESKTOP = path.join(AUTOSTART_DIR, 'agiodesign-bridge.desktop');
const LINUX_START = path.join(DATA_DIR, 'start.sh');

// Pre-rename login items ("HTML to Figma" bridge).
const LEGACY_MAC_LABEL = 'com.htmltofigma.bridge';
const LEGACY_MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_MAC_LABEL}.plist`);
const LEGACY_WIN_VBS = path.join(STARTUP_DIR, 'HTML to Figma Bridge.vbs');
const LEGACY_LINUX_DESKTOP = path.join(AUTOSTART_DIR, 'html-to-figma-bridge.desktop');
const LEGACY_LINUX_START = path.join(LEGACY_DATA_DIR, 'start.sh');

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
  try {
    pids.add(Number(fs.readFileSync(path.join(LEGACY_DATA_DIR, 'bridge.pid'), 'utf8').trim()));
  } catch {
    /* no legacy pid file */
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
  <array>${PROGRAM.map((a) => `<string>${xmlEsc(a)}</string>`).join('')}</array>
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
    const cmd = IS_BINARY
      ? `cmd /c ""${BIN_PATH}" serve >> "${LOG_FILE}" 2>&1"`
      : `cmd /c ""${NODE}" "${SERVER}" >> "${LOG_FILE}" 2>&1"`;
    const vbs = `' Starts the agioDesign bridge at login (hidden window).\r\nCreateObject("WScript.Shell").Run "${vbsEsc(cmd)}", 0, False\r\n`;
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
      `#!/bin/sh\n# Starts the agioDesign bridge (written by install.mjs).\nPATH=${shEsc(capturedPath())}\nexport PATH\nexec ${PROGRAM.map(shEsc).join(' ')} >> ${shEsc(LOG_FILE)} 2>&1\n`,
      { mode: 0o755 },
    );
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=agioDesign Bridge',
      'Comment=Local bridge for the agioDesign Figma plugin',
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

/** Remove the login item left by an install from before the rename. */
function removeLegacy() {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(LEGACY_MAC_PLIST)) return;
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LEGACY_MAC_LABEL}`], { stdio: 'ignore' });
    fs.rmSync(LEGACY_MAC_PLIST, { force: true });
  } else if (process.platform === 'win32') {
    fs.rmSync(LEGACY_WIN_VBS, { force: true });
  } else {
    fs.rmSync(LEGACY_LINUX_DESKTOP, { force: true });
    fs.rmSync(LEGACY_LINUX_START, { force: true });
  }
}

// ---- commands ----

async function install() {
  const [major] = process.versions.node.split('.').map(Number);
  if (!IS_BINARY && major < 18) throw new Error(`Node.js 18 or newer is required (found ${process.versions.node}). Get it from https://nodejs.org`);
  removeLegacy();
  await stopRunning();
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  installBinary();
  platform.install();
  const up = (await waitFor(true)) && (await health());
  if (!up || typeof up.enabled !== 'boolean') {
    throw new Error(`Installed, but the bridge didn't answer on port ${DEFAULT_PORT}. See ${LOG_FILE}`);
  }
  console.log('✓ Bridge installed — it now starts automatically when you log in.');
  console.log('');
  console.log('Next: open the plugin in Figma → AI tab → Bridge → Connect, then click Allow.');
  if (!IS_BINARY) console.log(`(If you move this plugin folder, run the installer again.)`);
}

async function uninstall() {
  removeLegacy();
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
// A double-clicked .exe closes its console window as soon as it exits.
const pause = async () => {
  if (!(IS_BINARY && process.platform === 'win32' && process.stdin.isTTY)) return;
  process.stdout.write('\nPress Enter to close…');
  await new Promise((r) => process.stdin.once('data', r));
};
run()
  .catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  })
  .then(pause)
  .then(() => process.exit());
