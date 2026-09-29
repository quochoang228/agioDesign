/**
 * Bridge controls for people who never open a terminal: shows whether the local
 * bridge is installed/running/paired/on and offers the one next step.
 */
import { useState } from 'react';
import type { BridgeApi, BridgeStatus } from './useBridge';
import { hostOs, installerName } from './useBridge';
import { IconChevron, IconPower } from '../icons';

const LABEL: Record<BridgeStatus, string> = {
  checking: 'Checking…',
  offline: 'Not running',
  unpaired: 'Not connected',
  off: 'Off',
  on: 'On',
};

/** Small coloured status dot + label, used in the chat toolbar. */
export function BridgeBadge({ status, onClick }: { status: BridgeStatus; onClick?: () => void }) {
  return (
    <button className={`bridge-badge s-${status}`} onClick={onClick} title="Local bridge">
      <span className="dot" />
      Bridge {LABEL[status].toLowerCase()}
    </button>
  );
}

export function BridgePanel({
  bridge,
  url,
  token,
  onChange,
}: {
  bridge: BridgeApi;
  url: string;
  token: string;
  onChange: (u: { bridgeUrl?: string; bridgeToken?: string }) => void;
}) {
  const { state, connect, setOn, refresh } = bridge;
  const [advanced, setAdvanced] = useState(false);
  const os = hostOs();
  const clis = state.clis ? Object.entries(state.clis).filter(([, ok]) => ok).map(([n]) => n) : [];

  return (
    <div className="glass card bridge-panel">
      <div className="bridge-head">
        <span className={`status-dot s-${state.status}`} />
        <div className="bridge-title">
          <strong>{LABEL[state.status]}</strong>
          <small>
            {state.status === 'on' && (clis.length ? `CLIs found: ${clis.join(', ')}` : 'No AI CLIs found on this computer')}
            {state.status === 'off' && 'Paused — CLI providers and web tools are unavailable.'}
            {state.status === 'unpaired' && 'The bridge is running. Connect this plugin to it once.'}
            {state.status === 'offline' && 'The bridge isn’t installed or isn’t running.'}
            {state.status === 'checking' && 'Looking for the bridge…'}
          </small>
        </div>
        {(state.status === 'on' || state.status === 'off') && (
          <button
            className={state.status === 'on' ? 'btn btn-glass btn-sm' : 'btn btn-primary btn-sm'}
            disabled={state.busy === 'toggle'}
            onClick={() => setOn(state.status !== 'on')}
          >
            <IconPower />
            {state.status === 'on' ? 'Turn off' : 'Turn on'}
          </button>
        )}
        {state.status === 'unpaired' && (
          <button className="btn btn-primary btn-sm" disabled={state.busy === 'pair'} onClick={connect}>
            {state.busy === 'pair' ? 'Waiting…' : 'Connect'}
          </button>
        )}
      </div>

      {state.busy === 'pair' && (
        <p className="note">A dialog opened on your computer — click <b>Allow</b> to finish connecting.</p>
      )}

      {state.status === 'offline' && (
        <div className="steps">
          <p>Install it once — it then starts by itself whenever you log in:</p>
          <ol>
            <li>Open this plugin’s folder, then the <code>bridge</code> folder.</li>
            <li>
              Double-click <code>{installerName(os)}</code>
              {os === 'macOS' && ' (if macOS blocks it: right-click → Open)'}
              {os === 'Linux' && ' (or run it from a terminal)'}.
            </li>
            <li>Come back here and click Connect.</li>
          </ol>
          <p className="hint">Needs Node.js 18+ (nodejs.org) and at least one AI CLI (claude, codex or opencode).</p>
          <button className="btn btn-glass btn-sm" onClick={refresh}>
            Check again
          </button>
        </div>
      )}

      {state.error && <p className="note error">{state.error}</p>}

      <button className="disclosure" onClick={() => setAdvanced((v) => !v)}>
        <IconChevron open={advanced} /> Advanced
      </button>
      {advanced && (
        <label className="field">
          <span>Address</span>
          <input className="input" type="text" value={url} onChange={(e) => onChange({ bridgeUrl: e.target.value.trim() })} />
        </label>
      )}
      {advanced && (
        <label className="field">
          <span>Token</span>
          <input
            className="input"
            type="password"
            placeholder="Filled in automatically by Connect"
            value={token}
            onChange={(e) => onChange({ bridgeToken: e.target.value.trim() })}
          />
          <small className="hint">
            Only needed if the Allow dialog can’t appear (e.g. Linux without zenity): copy it from{' '}
            <code>~/.agiodesign-bridge/token</code>.
          </small>
        </label>
      )}
    </div>
  );
}
