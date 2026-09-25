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

/** Openverse: 20 results a page (or `count`), 3 pages (none with `none`), page 2 on after `laterDelay`;
 *  everything else answers "no results". */
async function fakeWeb(page: Page, opts: { openverseDelay?: number; laterDelay?: number; none?: boolean; count?: number } = {}) {
  await page.route(/^https:\/\/(?!localhost)/, async (route: Route) => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
      const name = url.split('/').pop()!;
      return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(new URL(name, ORT)) });
    }
    if (url.startsWith('https://api.openverse.org/')) {
      const u = new URL(url), q = u.searchParams.get('q') ?? '', p = +(u.searchParams.get('page') ?? 1);
      if (opts.openverseDelay) await new Promise((r) => setTimeout(r, opts.openverseDelay));
      if (opts.laterDelay && p > 1) await new Promise((r) => setTimeout(r, opts.laterDelay)); // page 2 on: a slow connection
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

/** Opens result i of the current results and presses More like this; resolves with the title it searches like. */
async function moreLike(page: Page, i = 0) {
  await expect(cells(page).nth(i)).toBeVisible({ timeout: 30_000 });
  await cells(page).nth(i).locator('.r-open').click();
  await page.locator('.r-viewer').getByRole('button', { name: 'More like this' }).click();
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  return (await page.locator('.r-back b').textContent()) ?? '';
}
const likeTitle = (page: Page) => page.locator('.r-back b');

test('toasts hide on time, and over the viewer they can be clicked and reached with Tab', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  const viewer = page.locator('.r-viewer'),
    t = page.locator('.toast');
  await viewer.getByRole('button', { name: 'Good match' }).click();
  await expect(t).toContainText('Noted');
  await expect(t).toBeHidden({ timeout: 4000 }); // a 1.5 s toast
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  const view = t.getByRole('button', { name: 'View' });
  await expect(view).toBeVisible();
  // on top of the viewer, not under its backdrop
  expect(await view.evaluate((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; })).toBe(true);
  let reached = false;
  for (let k = 0; k < 20 && !reached; k++) {
    await page.keyboard.press('Tab');
    reached = await view.evaluate((b) => b === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.press('Enter');
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.r-saved h2')).toContainText('Saved references · 1');
});

test('Save again after removing it in the viewer (or its Undo) keeps the folder it was in', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  const viewer = page.locator('.r-viewer');
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#saved-toggle').click();
  await page.locator('.r-saved .r-cell').first().hover();
  await page.getByRole('button', { name: /^Move .* to a folder$/ }).click();
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  await page.getByLabel('New folder name', { exact: true }).fill('Lamps');
  await page.getByLabel('New folder name', { exact: true }).press('Enter');
  await expect(page.locator('.r-folders')).toContainText('Lamps · 1');
  const folders = () => page.evaluate(() => Object.values((JSON.parse(localStorage.getItem('ab:refs-saved') ?? '{}') as { value?: Record<string, { folder?: string }> }).value ?? {}).map((r) => r.folder ?? null));
  const [inLamps] = await folders();
  expect(inLamps).toBeTruthy();
  await page.locator('.r-saved .r-open').first().click();
  await viewer.getByRole('button', { name: 'Saved', exact: true }).click();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(viewer).toHaveCount(1); // the click reached the toast, not the backdrop
  expect(await folders()).toEqual([inLamps]);
  await expect(viewer.getByRole('button', { name: 'Saved', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await viewer.getByRole('button', { name: 'Saved', exact: true }).click();
  expect(await folders()).toEqual([]);
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await folders()).toEqual([inLamps]);
});

test('More like this: Back and Forward walk the chain, and a stale Undo stays in the app', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await page.goto('about:blank');
  await openRefs(page);
  await search(page, 'lantern');
  const a = await moreLike(page);
  const b = await moreLike(page);
  expect(b).not.toBe(a);
  await page.goBack();
  await expect(likeTitle(page)).toHaveText(a);
  await expect(page.locator('.toast')).toBeHidden(); // its Undo was for the search just left
  await page.goForward();
  await expect(likeTitle(page)).toHaveText(b);
  await page.goBack();
  await expect(likeTitle(page)).toHaveText(a);
  await page.goBack();
  await expect(page.locator('.r-panel')).toHaveCount(0);
  await expect(page.locator('#r-q')).toHaveValue('lantern');
  // the (hidden) Undo of the last More like this, clicked anyway: nothing to undo here, so it mustn't go back
  await page.locator('.toast-action').evaluate((x) => (x as HTMLButtonElement).click());
  await page.waitForTimeout(500);
  expect(page.url()).toContain('view=refs');
});

test('Forward after closing the viewer keeps the More like this results', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  const a = await moreLike(page);
  await cells(page).nth(2).locator('.r-open').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await page.goForward();
  await page.waitForTimeout(600);
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await expect(likeTitle(page)).toHaveText(a);
  await page.goBack();
  await expect(page.locator('.r-panel')).toHaveCount(0);
});

test('More like this after a stick-figure search drops the drawing’s dots; Back brings back the edited ones', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await page.setInputFiles('#r-file', new URL('stick-arms-up.png', FIX).pathname);
  const dots = page.locator('.r-joint');
  await expect(dots).toHaveCount(11, { timeout: 20_000 });
  const box = (await dots.nth(4).boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 60, { steps: 5 });
  await page.mouse.up();
  const at = () => dots.nth(4).evaluate((d) => [parseFloat((d as HTMLElement).style.left), parseFloat((d as HTMLElement).style.top)]);
  const moved = await at();
  await moreLike(page);
  await expect(dots).toHaveCount(0);
  await expect(page.locator('.r-reading')).toHaveCount(0);
  await page.goBack();
  await expect(dots).toHaveCount(11);
  const back = await at();
  expect(back[0]).toBeCloseTo(moved[0], 3);
  expect(back[1]).toBeCloseTo(moved[1], 3);
  await expect(page.locator('.r-reading')).toContainText(/pose/i);
});

test('Back from a More like this crop that is still loading stays on the text search', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  // the crop's pixels come from wsrv.nl: make that slow
  await page.route(/&w=1024&h=1024&fit=inside&output=jpg$/, async (r) => {
    await new Promise((f) => setTimeout(f, 2500));
    await r.fallback();
  });
  await openRefs(page);
  await search(page, 'lantern');
  await moreLike(page, 1);
  const se = (await page.locator('.r-crop i[data-h=se]').boundingBox())!;
  await page.mouse.move(se.x + 4, se.y + 4);
  await page.mouse.down();
  await page.mouse.move(se.x - 80, se.y - 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  await page.locator('.r-back').click();
  await expect(page.locator('.r-panel')).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(page.locator('.r-panel')).toHaveCount(0);
  await expect(page.locator('.toast')).toBeHidden();
});

test('Back after switching to Briefs shows References again, as the address says', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  const a = await moreLike(page);
  await page.locator('[data-view=briefs]').click();
  await expect(page.locator('.r-page')).toBeHidden();
  await page.goBack();
  await expect(page.locator('.r-page')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('view')).toBe('refs');
  await expect(page.locator('[data-view=refs]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.r-panel')).toHaveCount(0);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  // Forward to the entry left on Briefs: Briefs, and References picks that search up when shown
  await page.goForward();
  await expect(page.locator('.r-page')).toBeHidden();
  expect(new URL(page.url()).searchParams.get('view')).toBeNull();
  await page.locator('[data-view=refs]').click();
  await expect(likeTitle(page)).toHaveText(a);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
});

test('viewer: a double-click near the edge leaves it open; closing focuses the result you ended on, in view', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).nth(11)).toBeVisible({ timeout: 30_000 });
  // a cell under the bottom edge, below where the viewer's card goes
  const under = () =>
    page.evaluate(() => {
      const y = innerHeight - 10;
      for (const c of document.querySelectorAll('.r-grid .r-cell:not([hidden])')) {
        const r = c.getBoundingClientRect();
        if (r.top < y - 4 && r.bottom > y + 4) return { x: r.x + r.width / 2, y };
      }
      return null;
    });
  let at = await under();
  for (let k = 0; k < 4 && !at; k++) {
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(200);
    at = await under();
  }
  expect(at).not.toBeNull();
  await page.mouse.dblclick(at!.x, at!.y);
  await page.waitForTimeout(300);
  await expect(page.locator('.r-viewer')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  // scroll down, open a result there and walk back to the first one, then close
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const i = await cells(page).evaluateAll((els) => els.findIndex((e) => e.getBoundingClientRect().top > 200));
  await cells(page).nth(i).locator('.r-open').click();
  for (let k = 0; k < i; k++) await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.r-vcount')).toHaveText(/^1 of/);
  await page.keyboard.press('Escape');
  const f = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement, r = a.getBoundingClientRect();
    return { first: a === document.querySelector('.r-grid .r-open'), top: r.top, bottom: r.bottom, bar: document.querySelector('.r-barrow')!.getBoundingClientRect().bottom, h: innerHeight };
  });
  expect(f.first).toBe(true);
  expect(f.top).toBeGreaterThanOrEqual(f.bar - 1);
  expect(f.bottom).toBeLessThanOrEqual(f.h);
});

test('focus that scrolls the page up stops below the sticky search bar', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).nth(11)).toBeAttached({ timeout: 30_000 });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const f = await page.evaluate(() => {
    const o = document.querySelector<HTMLElement>('.r-grid .r-open')!,
      bar = document.querySelector('.r-barrow')!.getBoundingClientRect().bottom,
      was = o.getBoundingClientRect().top;
    o.focus();
    return { was, top: o.getBoundingClientRect().top, bar };
  });
  expect(f.was).toBeLessThan(f.bar); // it was under the bar or above the screen
  expect(f.top).toBeGreaterThanOrEqual(f.bar - 1);
});

test('viewer: skips pictures the grid hid and counts like the grid; closing lands on a cell you can see', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  // a third of the pictures can't be shown, directly or through wsrv.nl (ranking still reads them): the grid hides those
  await page.route(/^https:\/\/(?!localhost)/, (r) => {
    const u = new URL(r.request().url());
    const src = u.host === 'wsrv.nl' ? `https://${u.searchParams.get('url')}` : u.href;
    return r.request().resourceType() === 'image' && hash(src) % 3 === 0 ? r.abort() : r.fallback();
  });
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.r-grid .r-cell[hidden]').first()).toBeAttached({ timeout: 30_000 });
  const s = await page.evaluate(() => {
    const cs = [...document.querySelectorAll<HTMLElement>('.r-grid .r-cell')];
    const i = cs.findIndex((c, k) => !c.hidden && cs[k + 1]?.hidden && cs.slice(k + 1).some((d) => !d.hidden));
    return { i, before: cs.slice(0, i).filter((c) => c.hidden).length, next: cs.slice(i + 1).find((c) => !c.hidden)?.querySelector('.r-cap span')?.textContent };
  });
  expect(s.i).toBeGreaterThanOrEqual(0);
  await page.locator('.r-grid .r-cell').nth(s.i).locator('.r-open').click();
  const count = page.locator('.r-vcount');
  await expect(count).toHaveText(new RegExp(`^${s.i + 1 - s.before} of`));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.r-viewer h2')).toHaveText(s.next!);
  await expect(count).toHaveText(new RegExp(`^${s.i + 2 - s.before} of`));
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.activeElement!.className === 'r-open' && (document.activeElement as HTMLElement).offsetParent !== null)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => +(document.querySelector('#r-status')?.textContent?.match(/^(\d+) references/)?.[1] ?? -1) - document.querySelectorAll('.r-grid .r-cell:not([hidden])').length))
    .toBe(0);
});

test('viewer: after Flip, a Similar pick opens unflipped; one that isn\u2019t in the grid opens too', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).nth(5)).toBeVisible({ timeout: 30_000 });
  const inGrid = new Set(await page.locator('.r-grid .r-cell:not([hidden]) .r-cap span:first-child').allTextContents());
  const viewer = page.locator('.r-viewer'),
    title = viewer.locator('h2'),
    strip = viewer.locator('.r-mini button'),
    pick = (label: string) => viewer.locator(`.r-mini button[aria-label=${JSON.stringify(label)}]`).first();
  let on: string | undefined, off: string | undefined, k = 0;
  for (; k < 6; k++) {
    await cells(page).nth(k).locator('.r-open').click();
    await expect(strip.first()).toBeVisible();
    const labels = await strip.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    on = labels.find((l) => inGrid.has(l));
    off = labels.find((l) => !inGrid.has(l));
    if (on && off) break;
    await page.keyboard.press('Escape');
  }
  expect(on && off).toBeTruthy();
  const from = (await title.textContent())!;
  await viewer.getByRole('button', { name: 'Flip' }).click();
  await expect(viewer.locator('.r-pic')).toHaveClass(/r-flipped/);
  await pick(on!).click();
  await expect(title).toHaveText(on!);
  await expect(viewer.locator('.r-pic')).not.toHaveClass(/r-flipped/);
  await expect(viewer.getByRole('button', { name: 'Flip' })).toHaveAttribute('aria-pressed', 'false');
  // back to where we were, then the pick that isn't in the grid: it opens here, it doesn't start a new search
  await page.keyboard.press('Escape');
  await cells(page).nth(k).locator('.r-open').click();
  await pick(off!).click();
  await expect(viewer).toHaveCount(1);
  await expect(title).toHaveText(off!);
  await expect(page.locator('.r-vcount')).toHaveText('Similar');
  await expect(likeTitle(page)).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(title).toHaveText(from);
});

test('viewer: closed while Next is still loading more, it stays closed when the batch lands', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page, { laterDelay: 4000 });
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  await cells(page).first().locator('.r-open').click();
  // walk to the end of what's loaded: there, Next has to wait for the next batch
  const next = page.locator('#r-vnext');
  let busy = false;
  for (let k = 0; k < 80 && !busy; k++) {
    await page.keyboard.press('ArrowRight');
    busy = (await next.getAttribute('aria-busy')) === 'true';
  }
  expect(busy).toBe(true);
  const had = await page.locator('.r-grid .r-cell').count();
  await page.keyboard.press('Escape');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await expect.poll(() => page.locator('.r-grid .r-cell').count(), { timeout: 15_000 }).toBeGreaterThan(had); // it landed after the close
  await page.waitForTimeout(400);
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  expect(await page.evaluate(() => [document.getElementById('app')!.inert, document.documentElement.classList.contains('r-noscroll')])).toEqual([false, false]);
});

test('More like this starts with its Similar strip; cropping it ranks afresh instead of keeping those on top', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).nth(5)).toBeVisible({ timeout: 30_000 });
  await cells(page).first().locator('.r-open').click();
  const strip = page.locator('.r-viewer .r-mini button');
  await expect(strip.first()).toBeVisible();
  const seeds = await strip.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  await page.locator('.r-viewer').getByRole('button', { name: 'More like this' }).click();
  const top = () => page.locator('.r-grid .r-cell .r-cap span:first-child').evaluateAll((els, n) => els.slice(0, n).map((e) => e.textContent), seeds.length);
  await expect.poll(top, { timeout: 30_000 }).toEqual(seeds);
  const se = (await page.locator('.r-crop i[data-h=se]').boundingBox())!;
  await page.mouse.move(se.x + 4, se.y + 4);
  await page.mouse.down();
  await page.mouse.move(se.x - 90, se.y - 90, { steps: 4 });
  await page.mouse.up();
  await expect.poll(top, { timeout: 30_000 }).not.toEqual(seeds);
});

test('phone: over the viewer, a toast shows on top and its button works', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'phone layout');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'dragon');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  await cells(page).first().locator('.r-open').click();
  const viewer = page.locator('.r-viewer');
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  const view = page.locator('.toast').getByRole('button', { name: 'View' });
  await expect(view).toBeVisible();
  expect(await view.evaluate((b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; })).toBe(true);
  await view.click();
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.r-saved h2')).toContainText('Saved references · 1');
});

test.describe(() => {
  test.use({ serviceWorkers: 'block' }); // the model's download must go through page.route
  test('viewer: More like this and Similar appear once a result shown before ranking gets ranked', async ({ page }, info) => {
    test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
    await fakeWeb(page);
    // a first visit on a slow connection: the ranking model arrives after the first results are shown
    await page.route('**/models/mobileclip_s0_vision_w8.onnx', async (r) => {
      await new Promise((f) => setTimeout(f, 7000));
      await r.continue();
    });
    await openRefs(page);
    // web results only: the card catalogs come with their pictures already read, so they're ranked from the start
    await page.getByRole('button', { name: 'Search settings' }).click();
    for (const id of ['riftbound', 'lol', 'hearthstone', 'dnd', 'poses']) await page.locator(`#r-src-${id}`).uncheck();
    await page.keyboard.press('Escape');
    await search(page, 'lantern');
    await expect(cells(page).first()).toBeVisible({ timeout: 20_000 });
    await cells(page).first().locator('.r-open').click();
    const more = page.locator('.r-viewer').getByRole('button', { name: 'More like this' });
    await expect(more).toHaveCount(0);
    await expect(more).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.r-viewer .r-mini button').first()).toBeVisible({ timeout: 10_000 });
  });
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
