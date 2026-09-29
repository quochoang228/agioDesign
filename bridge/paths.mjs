/**
 * Locations shared by the bridge server and its installer. Everything the bridge
 * persists lives in one per-user folder so uninstalling is a single rm.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 3939;
export const DATA_DIR = path.join(os.homedir(), '.html-to-figma-bridge');
export const TOKEN_FILE = path.join(DATA_DIR, 'token');
/** `{ enabled: boolean }` — the on/off switch the plugin toggles. */
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const PID_FILE = path.join(DATA_DIR, 'bridge.pid');
export const LOG_FILE = path.join(DATA_DIR, 'bridge.log');
