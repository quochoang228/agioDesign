/**
 * Shared HTTP client for the local companion bridge (`bridge/server.mjs`).
 * Every bridge route except /health requires the `x-bridge-token` header; the
 * token is printed by the bridge on startup and pasted into plugin Settings.
 */

export interface BridgeConn {
  bridgeUrl?: string;
  bridgeToken?: string;
}

export const DEFAULT_BRIDGE_URL = 'http://localhost:3939';

export function bridgeBase(conn: BridgeConn): string {
  return (conn.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
}

/** fetch() a bridge route with the auth header, turning network/401 failures into readable errors. */
export async function bridgeFetch(conn: BridgeConn, route: string, init: RequestInit = {}): Promise<Response> {
  const base = bridgeBase(conn);
  let res: Response;
  try {
    res = await fetch(`${base}${route}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'x-bridge-token': conn.bridgeToken || '' },
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new Error(`Can't reach the local bridge at ${base}. Start it with:  npm run bridge`);
  }
  if (res.status === 401) {
    throw new Error('The bridge rejected the token — copy it from the bridge terminal into ⚙ Settings → Bridge token.');
  }
  return res;
}
