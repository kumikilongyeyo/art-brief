/** Network helpers for the reference sources. */

// The relay Worker (relay/ folder). Empty until it's deployed — relay sources then stay quiet.
export const RELAY: string = (import.meta.env.VITE_RELAY as string | undefined) ?? '';

const TIMEOUT = 4500;

/** fetch → JSON with a per-request timeout that also honours the search's own abort signal. */
export async function getJson<T = unknown>(url: string, signal: AbortSignal, timeout = TIMEOUT): Promise<T> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal.addEventListener('abort', stop, { once: true });
  const t = setTimeout(stop, timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 404) return {} as T; // several APIs answer "no results" with 404
    if (!r.ok) throw new Error(`${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', stop);
  }
}

/** Hosts whose pictures the page may read itself (they send CORS headers): ranked straight from them. */
const DIRECT = /^https:\/\/(cdn[a-z]\.artstation\.com|ddragon\.leagueoflegends\.com|cards\.scryfall\.io|upload\.wikimedia\.org|www\.dnd5eapi\.co|inaturalist-open-data\.s3\.amazonaws\.com|live\.staticflickr\.com|farm\d+\.staticflickr\.com|api\.openverse\.org)\//;
/** wsrv.nl refuses some hosts outright, and a busy address now and then (Cloudflare 1006): after a few
 *  failures in a row, our relay serves ranking thumbnails instead, for the rest of the visit. */
const RELAY_IMG = /^https:\/\/(th\.wallhaven\.cc|safebooru\.org)\//;
let proxyFails = 0;
export const proxyDown = () => proxyFails >= 4 && !!RELAY;
export function proxyWorked(ok: boolean) {
  proxyFails = ok ? 0 : proxyFails + 1;
}
const viaRelay = (src: string) => (RELAY ? `${RELAY}/img?u=${encodeURIComponent(src)}` : '');
/** A thumbnail the ranking model can read: straight from hosts that allow it; else a small 256² JPEG from
 *  wsrv.nl's global cache (it also adds the CORS header), or via our relay for hosts wsrv.nl refuses. */
export function rankUrl(thumb: string, whole = false): string {
  if (DIRECT.test(thumb)) return thumb;
  if (RELAY_IMG.test(thumb) || proxyDown()) return viaRelay(thumb);
  // pose searches need the whole figure (feet and head), so no crop there
  const fit = whole ? 'w=320&h=320&fit=inside' : 'w=256&h=256&fit=cover';
  return `https://wsrv.nl/?url=${encodeURIComponent(thumb.replace(/^https?:\/\//, ''))}&${fit}&output=jpg&q=75`;
}

/** When a ranking thumbnail couldn't be read through wsrv.nl: the relay's copy ('' when there's none). */
export function rankFallback(thumb: string): string {
  return DIRECT.test(thumb) || RELAY_IMG.test(thumb) ? '' : viaRelay(thumb);
}
/** What to show when a picture won't load, in order: through wsrv.nl, or the original a wsrv.nl URL wraps
 *  (wsrv.nl may be refusing this address), then our relay's copy. */
export function imageAlts(src: string, w = 480): string[] {
  const wrapped = src.startsWith('https://wsrv.nl/') ? new URL(src).searchParams.get('url') : null;
  const original = wrapped ? `https://${wrapped.replace(/^https?:\/\//, '')}` : src;
  return [wrapped ? original : showUrl(src, w), viaRelay(original)].filter((u) => u && u !== src);
}

/** A display image through wsrv.nl: for hosts that serve huge originals or refuse to be shown on other sites. */
export function showUrl(src: string, w = 480): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(src.replace(/^https?:\/\//, ''))}&w=${w}&output=webp&q=80`;
}

export const qs = (o: Record<string, string | number | boolean | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

declare const __REFS_V__: string;
/** Loaded once per session: small static catalogs shipped with the app. */
const catalogCache = new Map<string, Promise<unknown>>();
export function catalog<T>(name: string): Promise<T> {
  if (!catalogCache.has(name)) {
    const p = fetch(`${import.meta.env.BASE_URL}refs/catalogs/${name}.json?v=${__REFS_V__}`).then((r) => {
      if (!r.ok) throw new Error(`catalog ${name}: ${r.status}`);
      return r.json();
    });
    p.catch(() => catalogCache.delete(name));
    catalogCache.set(name, p);
  }
  return catalogCache.get(name) as Promise<T>;
}
