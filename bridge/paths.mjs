/**
 * Locations shared by the bridge server and its installer. Everything the bridge
 * persists lives in one per-user folder so uninstalling is a single rm.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 3939;

/**
 * True when running as the packaged single-file executable (bun --compile),
 * where `process.execPath` is the bridge itself rather than node/bun.
 */
export const IS_BINARY = !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
/** Where the installer keeps its copy of the executable (stable login-item target). */
export const BIN_PATH = path.join(
  os.homedir(),
  '.agiodesign-bridge',
  'bin',
  process.platform === 'win32' ? 'agiodesign-bridge.exe' : 'agiodesign-bridge',
);
export const DATA_DIR = path.join(os.homedir(), '.agiodesign-bridge');
/** Folder used before the rename to agioDesign; its pairing is carried over. */
export const LEGACY_DATA_DIR = path.join(os.homedir(), '.html-to-figma-bridge');
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
/** `{ enabled: boolean }` — the on/off switch the plugin toggles. */
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const PID_FILE = path.join(DATA_DIR, 'bridge.pid');
export const LOG_FILE = path.join(DATA_DIR, 'bridge.log');

// Keep an existing pairing (token + on/off switch) across the rename. Copy, not
// move: a login item from the old install may still be writing its log there.
if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    for (const f of ['token', 'state.json']) {
      const from = path.join(LEGACY_DATA_DIR, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DATA_DIR, f));
    }
  } catch {
    /* start fresh — the user can pair again */
  }
}
