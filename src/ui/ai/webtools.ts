/**
 * Web tools (Phase 6). `web_fetch` reads a URL's readable text (direct, with a
 * bridge fallback for CORS-blocked sites); `web_search` runs a keyword search
 * through the local bridge (which has no CORS limits).
 */

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

export async function webFetch(rawUrl: string, bridgeUrl?: string): Promise<string> {
  const url = /^https?:\/\//.test(rawUrl) ? rawUrl : 'https://' + rawUrl;
  // Try a direct fetch first (works for CORS-friendly endpoints).
  try {
    const res = await fetch(url);
    if (res.ok) return clip(await res.text());
  } catch {
    /* fall through to the bridge */
  }
  if (bridgeUrl) {
    const base = bridgeUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/fetch?url=${encodeURIComponent(url)}`);
    if (res.ok) return clip(await res.text());
    throw new Error(`Bridge fetch ${res.status}`);
  }
  throw new Error('Direct fetch failed (likely CORS). Start the local bridge to fetch through it.');
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string, bridgeUrl?: string): Promise<{ results: SearchHit[] }> {
  if (!bridgeUrl) throw new Error('Web search needs the local bridge running (node bridge/server.mjs).');
  const base = bridgeUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Bridge search ${res.status}`);
  return await res.json();
}
