/**
 * Web tools (Phase 6). `web_fetch` reads a URL's readable text (direct, with a
 * bridge fallback for CORS-blocked sites); `web_search` runs a keyword search
 * through the local bridge (which has no CORS limits).
 */
import { bridgeFetch, type BridgeConn } from './bridgeClient';

function clip(html: string, max = 4000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, max);
}

export async function webFetch(rawUrl: string, bridge: BridgeConn): Promise<string> {
  const url = /^https?:\/\//.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
  // Try a direct fetch first (works for CORS-friendly endpoints).
  try {
    const res = await fetch(url);
    if (res.ok) return clip(await res.text());
  } catch {
    /* fall through to the bridge */
  }
  if (bridge.bridgeUrl) {
    const res = await bridgeFetch(bridge, `/fetch?url=${encodeURIComponent(url)}`);
    if (res.ok) return clip(await res.text());
    throw new Error(`Bridge fetch ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  throw new Error('Direct fetch failed (likely CORS). Start the local bridge to fetch through it.');
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string, bridge: BridgeConn): Promise<{ results: SearchHit[] }> {
  if (!bridge.bridgeUrl) throw new Error('Web search needs the local bridge running (npm run bridge).');
  const res = await bridgeFetch(bridge, `/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Bridge search ${res.status}`);
  return await res.json();
}
