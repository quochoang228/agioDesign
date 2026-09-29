/**
 * Network helpers for the bridge's web tools, split out of server.mjs so they
 * can be unit-tested without starting the server (`npm test`).
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** True for loopback, private, link-local, CGNAT, multicast and other non-public IPs. */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

/** Throws unless `raw` is an http(s) URL whose host resolves only to public IPs. */
export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) urls are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('refusing to fetch a private or local address');
  }
  return u;
}

/** fetch() that re-checks every redirect hop against the private-address guard. */
export async function publicFetch(raw, maxHops = 5) {
  let url = raw;
  for (let hop = 0; hop <= maxHops; hop++) {
    const u = await assertPublicUrl(url);
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) return r;
    url = new URL(loc, u).toString();
  }
  throw new Error('too many redirects');
}

/** Best-effort scrape of the DuckDuckGo HTML endpoint into {title,url,snippet}[]. */
export function parseDuckDuckGo(html) {
  const out = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
  const strip = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const links = [...html.matchAll(linkRe)];
  for (let i = 0; i < links.length && out.length < 6; i++) {
    const m = links[i];
    let href = m[1];
    if (href.includes('duckduckgo.com/y.js') || href.includes('ad_domain')) continue; // skip ads
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep raw */
      }
    }
    // A result's snippet sits between its link and the next result's link;
    // pairing by position would shift every snippet after a skipped ad.
    const end = i + 1 < links.length ? links[i + 1].index : html.length;
    const snip = html.slice(m.index + m[0].length, end).match(snipRe);
    out.push({ title: strip(m[2]), url: href, snippet: snip ? strip(snip[1]) : '' });
  }
  return out;
}
