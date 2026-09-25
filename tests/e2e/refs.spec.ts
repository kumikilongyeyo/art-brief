import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

// References, end to end, with every outside site faked: source APIs answer with fixture results whose
// images are small local JPEGs, wsrv.nl and the image CDNs serve those JPEGs, and the onnxruntime wasm
// comes from node_modules. The ranking model itself is real (served by the preview build).

const FIX = new URL('./fixtures/refs/', import.meta.url);
const IMGS = Array.from({ length: 12 }, (_, i) => readFileSync(new URL(`${i}.jpg`, FIX)));
const ORT = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url);
const jpg = (n: number) => ({ status: 200, contentType: 'image/jpeg', body: IMGS[Math.abs(n) % IMGS.length] });
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Openverse: 20 results a page (or `count`), 3 pages (none with `none`); everything else answers "no results". */
async function fakeWeb(page: Page, opts: { openverseDelay?: number; none?: boolean; count?: number } = {}) {
  await page.route(/^https:\/\/(?!localhost)/, async (route: Route) => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
      const name = url.split('/').pop()!;
      return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(new URL(name, ORT)) });
    }
    if (url.startsWith('https://api.openverse.org/')) {
      const u = new URL(url), q = u.searchParams.get('q') ?? '', p = +(u.searchParams.get('page') ?? 1);
      if (opts.openverseDelay) await new Promise((r) => setTimeout(r, opts.openverseDelay));
      const results = Array.from({ length: opts.count ?? 20 }, (_, i) => {
        const id = `${hash(q)}-${p}-${i}`;
        return { id, title: `${q} ${p}-${i}`, thumbnail: `https://img.test/${hash(id) % 12}.jpg?${id}`, url: `https://img.test/${hash(id) % 12}.jpg?${id}`, foreign_landing_url: `https://example.org/${id}`, tags: q.split(' ').map((name) => ({ name })), width: 400, height: 300 };
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.none ? { results: [], page_count: 0 } : { results, page_count: opts.count ? 1 : 3 }) });
    }
    if (url.startsWith('https://img.test/') || /wsrv\.nl|ddragon|hearthstonejson|cmsassets|dnd5eapi|scryfall\.io/.test(url)) return route.fulfill(jpg(hash(url)));
    if (/\.(jpe?g|png|webp)(\?|$)/.test(url)) return route.fulfill(jpg(hash(url)));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

async function openRefs(page: Page) {
  await page.goto('./?view=refs');
  await expect(page.locator('.r-page')).toBeVisible();
}
async function search(page: Page, q: string) {
  const box = page.locator('#r-q');
  await box.fill(q);
  await box.press('Enter');
}
const cells = (page: Page) => page.locator('.r-grid .r-cell:not([hidden])');
const onlyDesktopChromium = (name: string) => name !== 'chromium';

test.describe.configure({ timeout: 90_000 });

test('a text search shows results, and scrolling keeps loading more without duplicates', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'castle on a cliff');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  const first = await cells(page).count();
  for (let i = 0; i < 12 && (await cells(page).count()) <= first; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(700);
  }
  expect(await cells(page).count()).toBeGreaterThan(first);
  const keys = await page.locator('.r-grid .r-open').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(new Set(keys).size).toBe(keys.length);
});

test('results keep their place as more load, and the best ones lead across the top', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'castle on a cliff');
  await expect(cells(page).nth(9)).toBeVisible({ timeout: 30_000 });
  // where each cell's layout box sits in the grid: offsets leave out the slide-in transform of a new cell,
  // and the status line above the grid may change height as it updates
  const boxes = () =>
    page.locator('.r-grid .r-cell').evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => {
        const g = e.parentElement!;
        return e.offsetParent === g ? [e.offsetLeft, e.offsetTop] : [e.offsetLeft - g.offsetLeft, e.offsetTop - g.offsetTop];
      }),
    );
  const before = await boxes();
  for (let i = 0; i < 12 && (await cells(page).count()) <= before.length; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(700);
  }
  const after = await boxes();
  expect(after.length).toBeGreaterThan(before.length);
  expect(after.slice(0, before.length)).toEqual(before); // nothing already shown moved
  const top = before.slice(0, 4); // ranks 0–3 make the top row, left to right
  expect(new Set(top.map(([, y]) => y)).size).toBe(1);
  expect(top.map(([x]) => x)).toEqual(top.map(([x]) => x).sort((a, b) => a - b));
});

test('endless scroll carries on when the bottom comes back into range while a batch lands', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  // after every change (and before the next frame), scroll so the sentinel sits just inside the look-ahead:
  // the observer then never sees it leave, as when a quick scroll brings it back before the next frame
  await page.evaluate(() => {
    const keep = () => {
      const s = document.querySelector('.r-sentinel');
      if (s?.isConnected) scrollBy(0, s.getBoundingClientRect().top - (innerHeight + 1150));
    };
    new MutationObserver(() => queueMicrotask(keep)).observe(document.getElementById('r-main')!, { childList: true, subtree: true });
  });
  await search(page, 'castle on a cliff');
  await expect(page.locator('.r-grid .r-end')).toBeVisible({ timeout: 60_000 });
});

test('a search that finds nothing says so instead of spinning', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page, { none: true });
  await openRefs(page);
  await search(page, 'xqzvbnwq');
  await expect(page.locator('.r-empty h2')).toContainText('No close matches', { timeout: 30_000 });
  await expect(page.locator('.r-spin, .r-skel')).toHaveCount(0);
});

test('a search none of your sources cover says so, and leads to Search settings', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  // keep only the museums, which don't do figures
  await page.locator('.r-setbtn').click();
  for (const cb of await page.locator('.r-srcs input').all()) await cb.uncheck();
  for (const id of ['met', 'cleveland', 'artsmia']) await page.locator(`#r-src-${id}`).check();
  await page.keyboard.press('Escape');
  await search(page, 'knight holding a sword');
  await expect(page.locator('.r-empty h2')).toContainText('None of the sources you have on cover Pose searches', { timeout: 10_000 });
  await expect(page.locator('.r-skel')).toHaveCount(0);
  await page.locator('.r-empty').getByRole('button', { name: 'Search settings' }).click();
  await expect(page.locator('.r-settings')).toBeVisible();
});

test('an image search without the matching model says so, and Try again recovers', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const ort = /cdn\.jsdelivr\.net\/npm\/onnxruntime-web/;
  await page.route(ort, (route) => route.abort());
  await openRefs(page);
  await page.setInputFiles('#r-file', new URL('3.jpg', FIX).pathname);
  await expect(page.locator('.r-empty h2')).toContainText('Image search isn’t available', { timeout: 30_000 });
  await expect(page.locator('.r-skel')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.unroute(ort);
  await page.locator('.r-empty').getByRole('button', { name: 'Try again' }).click();
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
});

test('the status line counts only the pictures that load', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  // every Hearthstone picture fails to load, straight and through the wsrv.nl retry (the catalog's own
  // vectors still rank them, so they reach the grid and then drop out)
  await page.route(/hearthstonejson/, (route) => route.fulfill({ status: 429, body: '' }));
  await openRefs(page);
  await search(page, 'castle on a cliff');
  await expect(page.locator('.r-grid .r-cell[hidden]').first()).toBeAttached({ timeout: 30_000 });
  const counted = async () => {
    const n = await cells(page).count();
    return (await page.locator('#r-status').textContent())?.startsWith(`${n} reference${n === 1 ? '' : 's'} from`);
  };
  await expect.poll(counted).toBe(true);
  expect(await page.locator('.r-grid .r-cell').count()).toBeGreaterThan(await cells(page).count());
});

test('one result reads "1 reference from 1 source"', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page, { count: 1 }); // only Openverse on, answering with one picture
  await openRefs(page);
  await page.locator('.r-setbtn').click();
  for (const cb of await page.locator('.r-srcs input').all()) await cb.uncheck();
  await page.locator('#r-src-openverse').check();
  await page.keyboard.press('Escape');
  // every status line on the way, "Searching 1 source…" included
  await page.evaluate(() => {
    const seen: string[] = ((globalThis as { __said?: string[] }).__said = []);
    new MutationObserver(() => {
      const t = document.getElementById('r-status')?.textContent;
      if (t && seen.at(-1) !== t) seen.push(t);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await search(page, 'lighthouse');
  await expect(page.locator('#r-status')).toHaveText('1 reference from 1 source', { timeout: 30_000 });
  const said = await page.evaluate(() => (globalThis as { __said?: string[] }).__said ?? []);
  expect(said.filter((t) => /\b1 (references|sources)\b/.test(t))).toEqual([]);
});

test('a second search while the first is still loading gets its own results', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page, { openverseDelay: 600 });
  await openRefs(page);
  await search(page, 'dragon');
  await page.waitForTimeout(300);
  await search(page, 'lantern');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  // the fixture titles say which search they came from: nothing from the first search may appear
  const labels = await page.locator('.r-grid .r-open').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  expect(labels.some((l) => /^dragon \d-/.test(l))).toBe(false);
});

test('a pose search never freezes the page and still delivers', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'knight holding a sword');
  // the page must stay responsive while it works: every probe answers within a second
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    await page.evaluate(() => 1);
    expect(Date.now() - t).toBeLessThan(1000);
    await page.waitForTimeout(400);
  }
  await expect(page.locator('#r-status')).not.toHaveText(/^$/);
});

test('a stick figure is read into joints you can drag', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await page.setInputFiles('#r-file', new URL('stick-arms-up.png', FIX).pathname);
  await expect(page.locator('.r-joint')).toHaveCount(11, { timeout: 20_000 });
  await expect(page.locator('.r-reading')).toContainText(/pose/i);
  const dot = page.locator('.r-joint').nth(4);
  const box = (await dot.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.r-reading')).toContainText(/drag a dot/i);
});

test('save a reference, find it in Saved after a reload, remove it with undo', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  await page.locator('.r-viewer').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('Saved');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.r-page')).toBeVisible();
  await page.locator('#saved-toggle').click();
  await expect(page.locator('.r-saved h2')).toContainText('Saved references · 1');
  await page.locator('.r-saved .r-cell').first().hover();
  await page.getByRole('button', { name: /^Remove / }).click();
  await expect(page.locator('.r-saved h2')).toContainText('· 0');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.r-saved h2')).toContainText('· 1');
});

test('a save the browser refuses says so and is not marked saved', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  await page.locator('.r-viewer').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('Couldn’t save');
  await expect(page.locator('.r-viewer').getByRole('button', { name: 'Save' })).toHaveAttribute('aria-pressed', 'false');
});

test('search results never leak into the Saved view', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page, { openverseDelay: 800 });
  await openRefs(page);
  await search(page, 'dragon');
  await page.locator('#saved-toggle').click();
  await page.waitForTimeout(4000);
  await expect(page.locator('.r-saved .r-cell')).toHaveCount(0);
});

test('viewer: normal-size icons, Esc closes, Back closes', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  const sizes = await page.locator('.r-viewer svg.r-i').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(Math.max(...sizes)).toBeLessThanOrEqual(24);
  await page.keyboard.press('Escape');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await cells(page).first().locator('.r-open').click();
  await page.goBack();
  await expect(page.locator('.r-viewer')).toHaveCount(0);
});

test('the start screen shows a fresh set of ideas on every visit, and a tile runs its search', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  const tiles = page.locator('button.r-tile');
  await expect(tiles).toHaveCount(8);
  const first = await tiles.allTextContents();
  await page.reload();
  await expect(tiles).toHaveCount(8);
  const second = await tiles.allTextContents();
  expect(second.filter((t) => first.includes(t))).toEqual([]); // nothing repeats from the last visit
  await page.locator('[data-view=briefs]').click();
  await page.locator('[data-view=refs]').click();
  await expect(tiles).toHaveCount(8);
  expect((await tiles.allTextContents()).filter((t) => second.includes(t))).toEqual([]);
  await tiles.first().click();
  await expect(page.locator('#r-q')).not.toHaveValue('');
  await expect(page.locator('.r-tiles')).toHaveCount(0);
});

test('the start screen has a feed of new work: fresh each visit, no ratings, More like this and back', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  const feed = page.locator('.r-feed .r-cell:not([hidden])');
  await expect(feed.nth(9)).toBeVisible({ timeout: 20_000 });
  const first = await page.locator('.r-feed .r-open').evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute('aria-label')));
  await expect(page.locator('.r-feed .r-votes')).toHaveCount(0); // "good match" means nothing without a query
  await expect(page.locator('#r-modebtn')).not.toContainText('·'); // no guessed mode on the start screen
  await page.reload();
  await expect(feed.nth(9)).toBeVisible({ timeout: 20_000 });
  const again = await page.locator('.r-feed .r-open').evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute('aria-label')));
  expect(again).not.toEqual(first); // a new mix every visit
  await feed.first().locator('.r-open').click();
  const viewer = page.locator('.r-viewer');
  await expect(viewer.getByRole('button', { name: 'Good match' })).toHaveCount(0);
  await viewer.getByRole('button', { name: 'More like this' }).click();
  await expect(page.locator('.r-feed')).toHaveCount(0);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  await page.goBack();
  await expect(page.locator('.r-feed')).toBeVisible();
  expect(await page.locator('.r-feed .r-open').evaluateAll((els) => els.slice(0, 10).map((e) => e.getAttribute('aria-label')))).toEqual(again);
});

test('phone: References fits the screen', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'phone layout');
  await fakeWeb(page);
  await openRefs(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#r-q').fill('dragon');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
