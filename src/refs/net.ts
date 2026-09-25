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

/** A thumbnail the ranking model can read: a small 256² JPEG from wsrv.nl's global cache (it also
 *  adds the CORS header), or via our relay for the hosts wsrv.nl refuses. */
const RELAY_IMG = /^https:\/\/(th\.wallhaven\.cc|safebooru\.org)\//;
export function rankUrl(thumb: string, whole = false): string {
  if (RELAY_IMG.test(thumb)) return RELAY ? `${RELAY}/img?u=${encodeURIComponent(thumb)}` : '';
  // pose searches need the whole figure (feet and head), so no crop there
  const fit = whole ? 'w=320&h=320&fit=inside' : 'w=256&h=256&fit=cover';
  return `https://wsrv.nl/?url=${encodeURIComponent(thumb.replace(/^https?:\/\//, ''))}&${fit}&output=jpg&q=75`;
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
