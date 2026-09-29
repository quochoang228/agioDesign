/**
 * Live status of the local bridge, polled from /health, plus the actions the
 * plugin can take on it without a terminal: pair (native Allow dialog on the
 * user's machine hands us the token) and turn on/off.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeBase, bridgeFetch, type BridgeConn } from './bridgeClient';

export type BridgeStatus = 'checking' | 'offline' | 'unpaired' | 'off' | 'on';

export interface BridgeState {
  status: BridgeStatus;
  clis?: Record<string, boolean>;
  /** An action in flight: waiting for the pairing dialog, or toggling. */
  busy: null | 'pair' | 'toggle';
  error: string | null;
}

const POLL_MS = 3000;

export function useBridge(conn: BridgeConn, onToken: (token: string) => void) {
  const [state, setState] = useState<BridgeState>({ status: 'checking', busy: null, error: null });
  const connRef = useRef(conn);
  connRef.current = conn;

  const check = useCallback(async () => {
    const c = connRef.current;
    try {
      const res = await fetch(`${bridgeBase(c)}/health`, {
        headers: c.bridgeToken ? { 'x-bridge-token': c.bridgeToken } : {},
        signal: AbortSignal.timeout(2000),
      });
      const h = await res.json();
      const status: BridgeStatus = !h.authorized ? 'unpaired' : h.enabled === false ? 'off' : 'on';
      setState((s) => ({ ...s, status, clis: h.clis }));
    } catch {
      setState((s) => ({ ...s, status: 'offline', clis: undefined }));
    }
  }, []);

  useEffect(() => {
    check();
    const t = setInterval(check, POLL_MS);
    return () => clearInterval(t);
  }, [check, conn.bridgeUrl, conn.bridgeToken]);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, busy: 'pair', error: null }));
    try {
      const res = await fetch(`${bridgeBase(connRef.current)}/pair`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw new Error(body.error || `Pairing failed (${res.status}).`);
      connRef.current = { ...connRef.current, bridgeToken: body.token };
      onToken(body.token);
      setState((s) => ({ ...s, busy: null }));
      await check();
    } catch (e) {
      const message = e instanceof TypeError ? "Can't reach the bridge." : (e as Error).message;
      setState((s) => ({ ...s, busy: null, error: message }));
    }
  }, [check, onToken]);

  const setOn = useCallback(
    async (on: boolean) => {
      setState((s) => ({ ...s, busy: 'toggle', error: null }));
      try {
        const res = await bridgeFetch(connRef.current, on ? '/control/enable' : '/control/disable', { method: 'POST' });
        if (!res.ok) throw new Error(`Bridge ${res.status}`);
        setState((s) => ({ ...s, busy: null }));
      } catch (e) {
        setState((s) => ({ ...s, busy: null, error: (e as Error).message }));
      }
      await check();
    },
    [check],
  );

  return { state, connect, setOn, refresh: check };
}

export type BridgeApi = ReturnType<typeof useBridge>;

/** The user's OS, for picking the right installer file name. */
export function hostOs(): 'macOS' | 'Windows' | 'Linux' {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macOS';
  if (/Win/i.test(ua)) return 'Windows';
  return 'Linux';
}

export function installerName(os = hostOs()): string {
  return os === 'macOS' ? 'Install Bridge (macOS).command' : os === 'Windows' ? 'Install Bridge (Windows).cmd' : 'Install Bridge (Linux).sh';
}
