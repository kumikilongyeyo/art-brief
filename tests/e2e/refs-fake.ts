import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';

// Every outside site faked for the reference board: source APIs answer with fixture results whose images
// are small local JPEGs, wsrv.nl and the image CDNs serve those JPEGs, and the onnxruntime wasm comes from
// node_modules. The ranking model itself is real (served by the preview build).

export const FIX = new URL('./fixtures/refs/', import.meta.url);
const IMGS = Array.from({ length: 12 }, (_, i) => readFileSync(new URL(`${i}.jpg`, FIX)));
const ORT = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url);
const jpg = (n: number) => ({ status: 200, contentType: 'image/jpeg', body: IMGS[Math.abs(n) % IMGS.length] });
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Openverse: 20 results a page, 3 pages; everything else answers "no results". */
export async function fakeWeb(page: Page) {
  await page.route(/^https:\/\/(?!localhost)/, async (route: Route) => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
      const name = url.split('/').pop()!;
      return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(new URL(name, ORT)) });
    }
    if (/^https:\/\/api\.openverse\.org\/v1\/images\/[^/?]+\/thumb\//.test(url)) return route.fulfill(jpg(hash(url))); // Openverse's own thumbnails
    if (url.startsWith('https://api.openverse.org/')) {
      const u = new URL(url),
        q = u.searchParams.get('q') ?? '',
        p = +(u.searchParams.get('page') ?? 1);
      const results = Array.from({ length: 20 }, (_, i) => {
        const id = `${hash(q)}-${p}-${i}`;
        return { id, title: `${q} ${p}-${i}`, thumbnail: `https://img.test/${hash(id) % 12}.jpg?${id}`, url: `https://img.test/${hash(id) % 12}.jpg?${id}`, foreign_landing_url: `https://example.org/${id}`, tags: q.split(' ').map((name) => ({ name })), width: 400, height: 300 };
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results, page_count: 3 }) });
    }
    if (url.startsWith('https://img.test/') || /wsrv\.nl|ddragon|hearthstonejson|cmsassets|dnd5eapi|scryfall\.io/.test(url)) return route.fulfill(jpg(hash(url)));
    if (/\.(jpe?g|png|webp)(\?|$)/.test(url)) return route.fulfill(jpg(hash(url)));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

export const fixture = (name: string) => readFileSync(new URL(name, FIX));
