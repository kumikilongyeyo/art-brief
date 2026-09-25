import { readFileSync } from 'node:fs';
import { expect, type Page, type Route } from '@playwright/test';

// References with every outside site faked: source APIs answer with fixture results whose images are small
// local JPEGs, wsrv.nl and the image CDNs serve those JPEGs, and the onnxruntime wasm comes from
// node_modules. The ranking model itself is real (served by the preview build). Same fakes as refs.spec.ts.

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

export async function openRefs(page: Page) {
  await page.goto('./?view=refs');
  await expect(page.locator('.r-page')).toBeVisible();
}
export async function search(page: Page, q: string) {
  const box = page.locator('#r-q');
  await box.fill(q);
  await box.press('Enter');
}
export const cells = (page: Page) => page.locator('.r-grid .r-cell:not([hidden])');
export const fixture = (name: string) => readFileSync(new URL(name, FIX));

/** A PNG drawn in the page: `draw` is the body of a function of (x: 2D context, w, h). Dark ink, round caps. */
export async function png(page: Page, w: number, h: number, draw: string, bg: string | null = '#fff'): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([w, h, draw, bg]) => {
      const c = new OffscreenCanvas(w, h),
        x = c.getContext('2d')!;
      if (bg) {
        x.fillStyle = bg;
        x.fillRect(0, 0, w, h);
      }
      Object.assign(x, { strokeStyle: '#111', fillStyle: '#111', lineCap: 'round', lineJoin: 'round' });
      new Function('x', 'w', 'h', draw)(x, w, h);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (const v of buf) s += String.fromCharCode(v);
      return btoa(s);
    },
    [w, h, draw, bg] as const,
  );
  return Buffer.from(b64, 'base64');
}

/** Pastes a file the way Cmd+V with an image on the clipboard does. */
export async function paste(page: Page, body: Buffer, name: string, type: string) {
  await page.evaluate(
    ([b64, name, type]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name, { type }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [body.toString('base64'), name, type] as const,
  );
}

/** Drags a file over the page and drops it. */
export async function dropFile(page: Page, body: Buffer, name: string, type: string) {
  const dt = await page.evaluateHandle(
    ([b64, name, type]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name, { type }));
      return dt;
    },
    [body.toString('base64'), name, type] as const,
  );
  await page.dispatchEvent('main', 'dragenter', { dataTransfer: dt });
  await page.dispatchEvent('main', 'dragover', { dataTransfer: dt });
  const overlay = await page.evaluate(() => document.body.classList.contains('r-dropping'));
  await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
  return { overlay };
}

/** The crop box as fractions of the picture. */
export async function cropBox(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('.r-crop')!.getBoundingClientRect(),
      w = document.querySelector('.r-imgwrap')!.getBoundingClientRect();
    const f = (n: number) => Math.round(n * 100) / 100;
    return { x: f((c.left - w.left) / w.width), y: f((c.top - w.top) / w.height), w: f(c.width / w.width), h: f(c.height / w.height) };
  });
}

/** A mouse drag in small steps, from and to fractions of the picture. */
export async function dragOnImage(page: Page, from: [number, number], to: [number, number]) {
  const r = (await page.locator('.r-imgwrap').boundingBox())!;
  await page.mouse.move(r.x + from[0] * r.width, r.y + from[1] * r.height);
  await page.mouse.down();
  await page.mouse.move(r.x + to[0] * r.width, r.y + to[1] * r.height, { steps: 10 });
  await page.mouse.up();
}
