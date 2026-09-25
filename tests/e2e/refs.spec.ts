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

/** Openverse: 20 results a page, 3 pages; everything else answers "no results". */
async function fakeWeb(page: Page, opts: { openverseDelay?: number } = {}) {
  await page.route(/^https:\/\/(?!localhost)/, async (route: Route) => {
    const url = route.request().url();
    if (url.includes('cdn.jsdelivr.net/npm/onnxruntime-web')) {
      const name = url.split('/').pop()!;
      return route.fulfill({ status: 200, contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(new URL(name, ORT)) });
    }
    if (url.startsWith('https://api.openverse.org/')) {
      const u = new URL(url), q = u.searchParams.get('q') ?? '', p = +(u.searchParams.get('page') ?? 1);
      if (opts.openverseDelay) await new Promise((r) => setTimeout(r, opts.openverseDelay));
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

test('the search bar: suggestions finish the word Enter searches, the × shows only with text, a menu closes the list', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  const box = page.locator('#r-q'),
    rows = page.locator('.r-sug [role=option]');
  await expect(page.locator('.r-clear')).toBeHidden();
  await box.pressSequentially('drago');
  await expect(rows.first()).toHaveText('dragon', { timeout: 20_000 }); // not "dragonfly": Enter searches "dragon"
  await expect(page.locator('.r-ghost')).toHaveText('dragon');
  await expect(page.locator('.r-clear')).toBeVisible();
  await box.press('Tab');
  await expect(box).toHaveValue('dragon ');
  await box.fill('');
  await box.pressSequentially('drag');
  await expect(rows.first()).toHaveText('dragon'); // the list stays open while "dragon" is typed
  await page.locator('#r-modebtn').click();
  await expect(page.locator('.r-menu')).toBeVisible();
  await expect(page.locator('.r-sug')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await box.fill('');
  await expect(page.locator('.r-clear')).toBeHidden();
});

test('narrowing belongs to its words, keeps its mode, and a mode change searches the words in the box', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  const asked: string[] = [];
  await page.route('https://api.openverse.org/**', (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('q') ?? '');
    return route.fallback();
  });
  await openRefs(page);
  const box = page.locator('#r-q'),
    row = page.locator('.r-narrow'),
    lastAsked = () => expect.poll(() => asked.at(-1), { timeout: 20_000 });
  await search(page, 'castle');
  await lastAsked().toBe('castle');
  await row.getByRole('button', { name: 'at dusk' }).click();
  await lastAsked().toBe('castle at dusk');
  await expect(row.getByRole('button', { name: 'in fog' })).toBeVisible(); // still the Place chips
  await expect(row.getByRole('button', { name: 'two-handed' })).toHaveCount(0);
  await search(page, 'lantern');
  await lastAsked().toBe('lantern');
  await expect(row.locator('.r-on')).toHaveCount(0);
  await box.fill('goblin');
  await box.press('Escape');
  await page.locator('#r-modebtn').click();
  await page.locator('.r-menu').getByRole('menuitemradio', { name: /Creature/ }).click();
  await lastAsked().toBe('goblin');
  await expect(box).toHaveValue('goblin');
});

test('switching a source off takes its results away without a new search', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  // "title, Source. Open": switch off whichever source the first result came from
  const sourceOf = (label: string | null) => (label ?? '').replace(/\. Open$/, '').split(', ').pop()!;
  const src = sourceOf(await cells(page).first().locator('.r-open').getAttribute('aria-label'));
  const fromIt = () => page.locator('.r-grid .r-open').evaluateAll((els, s) => els.filter((e) => e.getAttribute('aria-label')?.endsWith(`, ${s}. Open`)).length, src);
  await page.locator('.r-setbtn').click();
  await page.locator('.r-settings').getByLabel(src, { exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect.poll(fromIt, { timeout: 15_000 }).toBe(0);
});

test('a search from Saved shows its results, and text it can’t search stays in the box', async ({ page }, info) => {
  test.skip(onlyDesktopChromium(info.project.name), 'model-heavy: desktop Chromium only');
  await fakeWeb(page);
  await openRefs(page);
  const box = page.locator('#r-q');
  await box.pressSequentially('drago');
  await expect(page.locator('.r-sug [role=option]').first()).toBeVisible({ timeout: 20_000 }); // the vocabulary is in
  await search(page, '🐉🗡️');
  await expect(page.locator('.toast')).toContainText('words');
  await expect(box).toHaveValue('🐉🗡️');
  await search(page, 'pokémon trainer');
  await expect(box).toHaveValue('pokemon trainer');
  await page.locator('#saved-toggle').click();
  await expect(page.locator('.r-saved')).toBeVisible();
  await search(page, 'lantern');
  await expect(page.locator('.r-saved')).toHaveCount(0);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
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
