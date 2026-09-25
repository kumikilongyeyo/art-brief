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
  await expect(page.locator('#saved-toggle .badge')).toHaveText('0'); // the count isn't claimed either
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

// ---- Saved references: seeded straight into storage, so these need no search (and no model)
type Seed = { title: string; folder?: string; thumb?: string };
async function seedSaved(page: Page, refs: Seed[], folders: Array<{ id: string; name: string }> = []) {
  const saved = Object.fromEntries(
    refs.map((r, i) => {
      const key = `openverse:${r.title}`,
        thumb = r.thumb ?? `https://img.test/${i}.jpg`;
      return [
        key,
        {
          key,
          src: 'openverse',
          title: r.title,
          thumb,
          full: thumb,
          page: `https://example.org/${i}`,
          folder: r.folder,
          savedAt: 1000 - i,
        },
      ];
    }),
  );
  await page.goto('./');
  await page.evaluate(
    ([refs, folders]) => {
      localStorage.setItem('ab:refs-saved', refs);
      localStorage.setItem('ab:folders', folders);
    },
    [JSON.stringify({ v: 1, value: saved }), JSON.stringify({ schemaVersion: 1, value: folders.map((f) => ({ ...f, createdAt: 1 })) })],
  );
  await openRefs(page);
  await page.locator('#saved-toggle').click();
  await expect(page.locator('.r-saved h2')).toHaveText(`Saved references · ${refs.length}`);
}
type Stored = Record<string, { title: string; folder?: string; savedAt: number }>;
/** What's stored, newest first (the Saved grid's order), as "title@folder". */
const storedTitles = (page: Page) =>
  page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem('ab:refs-saved')!).value as Stored)
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((r) => `${r.title}${r.folder ? `@${r.folder}` : ''}`),
  );
const blockStorage = (page: Page) =>
  page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });

test('un-saving in the viewer updates the Saved grid, and Remove never saves again', async ({ page }) => {
  await fakeWeb(page);
  await seedSaved(page, [{ title: 'Alpha' }, { title: 'Bravo' }, { title: 'Charlie' }]);
  const saved = page.locator('.r-saved');
  await saved.getByRole('button', { name: 'Bravo. Open' }).click();
  await page.locator('.r-viewer').getByRole('button', { name: 'Saved' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await expect(saved.locator('h2')).toHaveText('Saved references · 2');
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 2']);
  await expect(page.locator('#saved-toggle .badge')).toHaveText('2');
  await expect(saved.locator('.r-open')).toHaveCount(2);
  await expect(page.locator(':focus')).toHaveAccessibleName('Charlie. Open'); // the cell now in its place
  await saved.getByRole('button', { name: 'Remove Alpha' }).click();
  await expect(page.locator('.toast')).toContainText('Removed from Saved');
  await expect(saved.locator('h2')).toHaveText('Saved references · 1');
  expect(await storedTitles(page)).toEqual(['Charlie']);
});

test('saving again in the viewer puts a reference back in its folder', async ({ page }) => {
  await fakeWeb(page);
  await seedSaved(page, [{ title: 'Alpha', folder: 'f-m' }, { title: 'Bravo' }], [{ id: 'f-m', name: 'Mechs' }]);
  const saved = page.locator('.r-saved');
  await saved.getByRole('button', { name: 'Mechs · 1' }).click();
  await saved.getByRole('button', { name: 'Alpha. Open' }).click();
  const star = page.locator('.r-viewer').getByRole('button', { name: /^Saved?$/ });
  await star.click();
  await expect(star).toHaveText('Save');
  await expect(saved.getByRole('button', { name: 'Mechs · 0' })).toHaveCount(1); // the grid under the viewer follows
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).dispatchEvent('click'); // the toast may sit under the viewer
  await expect(star).toHaveText('Saved');
  await expect(saved.getByRole('button', { name: 'Mechs · 1' })).toHaveCount(1);
  await star.click();
  await expect(star).toHaveText('Save');
  await star.click();
  await expect(star).toHaveText('Saved');
  await page.keyboard.press('Escape');
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 1', 'Mechs · 1']);
  await expect(page.locator(':focus')).toHaveAccessibleName('Alpha. Open');
  expect(await storedTitles(page)).toEqual(['Alpha@f-m', 'Bravo']); // same folder, same place in the list
});

test('touch: saved cells keep Move and Remove on screen, and filing into a new folder works', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'touch screens');
  await fakeWeb(page);
  await seedSaved(page, [{ title: 'Alpha' }, { title: 'Bravo' }]);
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
  const move = page.getByRole('button', { name: 'Move Alpha to a folder' });
  const remove = page.getByRole('button', { name: 'Remove Bravo' });
  for (const b of [move, remove]) {
    await expect(b).toBeVisible();
    await expect(b.locator('..')).toHaveCSS('opacity', '1');
  }
  await move.tap();
  await page.getByRole('menuitem', { name: 'New folder…' }).tap();
  await page.getByRole('textbox', { name: 'New folder name' }).fill('Mechs');
  await page.getByRole('button', { name: 'Create folder' }).tap();
  await expect(page.locator('.r-saved .r-chip')).toHaveText(['All · 2', 'Unsorted · 1', 'Mechs · 1']);
  await remove.tap();
  await expect(page.locator('.r-saved h2')).toHaveText('Saved references · 1');
});

test('with storage blocked, Saved keeps the real count and refuses removes, moves and new folders', async ({ page }) => {
  await fakeWeb(page);
  await seedSaved(page, [{ title: 'Alpha' }, { title: 'Bravo' }], [{ id: 'f-m', name: 'Mechs' }]);
  await blockStorage(page);
  const saved = page.locator('.r-saved');
  const badge = page.locator('#saved-toggle .badge');
  await saved.getByRole('button', { name: 'Remove Alpha' }).click();
  await expect(page.locator('.toast')).toContainText('Couldn’t save');
  await expect(saved.locator('h2')).toHaveText('Saved references · 2');
  await expect(badge).toHaveText('2');
  await saved.getByRole('button', { name: 'Move Alpha to a folder' }).click();
  await page.getByRole('menuitemradio', { name: 'Mechs' }).click();
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 2', 'Mechs · 0']);
  await saved.getByRole('button', { name: 'Move Alpha to a folder' }).click();
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  await page.getByRole('textbox', { name: 'New folder name' }).fill('Vehicles');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText('Couldn’t save');
  await page.keyboard.press('Escape');
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 2', 'Mechs · 0']);
  await saved.getByRole('button', { name: 'Bravo. Open' }).click();
  await page.locator('.r-viewer').getByRole('button', { name: 'Saved' }).click();
  await expect(page.locator('.r-viewer').getByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');
  await expect(badge).toHaveText('2');
  await expect(page.locator('#saved-toggle')).toHaveAttribute('aria-label', 'Saved references (2)');
});

test('Saved follows folders renamed or deleted on Briefs', async ({ page }) => {
  await fakeWeb(page);
  await seedSaved(
    page,
    [
      { title: 'Alpha', folder: 'f-h' },
      { title: 'Bravo', folder: 'f-m' },
    ],
    [
      { id: 'f-h', name: 'Heroes' },
      { id: 'f-m', name: 'Mechs' },
    ],
  );
  await page.locator('.r-saved').getByRole('button', { name: 'Mechs · 1' }).click();
  await page.locator('[data-view=briefs]').click();
  await page.locator('#saved-toggle').click();
  const panel = page.locator('#saved-panel');
  await panel.locator('.chip[data-filter="f-m"]').click();
  await panel.getByRole('button', { name: 'Delete folder Mechs' }).click();
  await panel.locator('.chip[data-filter="f-h"]').click();
  await panel.getByRole('button', { name: 'Rename folder Heroes' }).click();
  await panel.getByRole('textbox', { name: 'Rename folder' }).fill('Champions');
  await page.keyboard.press('Enter');
  await page.locator('[data-view=refs]').click();
  const saved = page.locator('.r-saved');
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 1', 'Champions · 1']);
  await expect(saved.locator('.r-chip.r-on')).toHaveText('All · 2');
  await saved.getByRole('button', { name: 'Move Bravo to a folder' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Unsorted' })).toHaveAttribute('aria-checked', 'true');
});

test('a saved reference whose picture is gone keeps its title and says so; a moved one comes back through the proxy', async ({ page }) => {
  await fakeWeb(page);
  // gone.test is gone everywhere; moved.test only answers through the image proxy
  await page.route(/gone\.test|moved\.test/, (r) => {
    const url = r.request().url();
    return url.startsWith('https://wsrv.nl/') && url.includes('moved.test') ? r.fallback() : r.fulfill({ status: 404, body: '' });
  });
  await seedSaved(page, [
    { title: 'Gone', thumb: 'https://gone.test/a.jpg' },
    { title: 'Moved', thumb: 'https://moved.test/b.jpg' },
  ]);
  const gone = page.locator('.r-saved .r-cell').first();
  await expect(gone).toHaveClass(/r-broken/);
  await expect(gone).toContainText('Image unavailable');
  await expect(gone.locator('.r-cap')).toHaveCSS('opacity', '1');
  await expect(gone.locator('.r-cap')).toContainText('Gone');
  await expect(gone.locator('.r-open')).toHaveAccessibleName('Gone, image unavailable. Open');
  const moved = page.locator('.r-saved .r-cell').nth(1);
  await expect(moved).toHaveClass(/r-loaded/);
  await expect(moved).not.toHaveClass(/r-broken/);
  await expect(moved.locator('img')).toHaveAttribute('src', /^https:\/\/wsrv\.nl\//);
  expect(await moved.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
});

test('keyboard focus stays in the Saved grid after Remove and Move', async ({ page }) => {
  await fakeWeb(page);
  await seedSaved(page, [{ title: 'Alpha' }, { title: 'Bravo' }, { title: 'Charlie' }]);
  const saved = page.locator('.r-saved');
  const focused = page.locator(':focus');
  await saved.getByRole('button', { name: 'Remove Bravo' }).focus();
  await page.keyboard.press('Enter');
  await expect(focused).toHaveAccessibleName('Charlie. Open');
  await saved.getByRole('button', { name: 'Move Alpha to a folder' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Archers');
  await page.keyboard.press('Enter');
  await expect(saved.locator('.r-chip')).toHaveText(['All · 2', 'Unsorted · 1', 'Archers · 1']);
  await expect(focused).toHaveAccessibleName('Move Alpha to a folder'); // still in view: its own button
  await saved.getByRole('button', { name: 'Unsorted · 1' }).click();
  await saved.getByRole('button', { name: 'Move Charlie to a folder' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(saved.locator('.r-chip.r-on')).toHaveText('Unsorted · 0');
  await expect(focused).toHaveAccessibleName('Unsorted · 0'); // the folder is empty now: its chip
});

test('on References the Saved button toggles the Saved view and says so', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  const btn = page.locator('#saved-toggle');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  for (const a of ['aria-haspopup', 'aria-controls', 'aria-expanded']) await expect(btn).not.toHaveAttribute(a);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '← Back to search' }).click();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await btn.click();
  await page.locator('[data-view=briefs]').click();
  await expect(btn).not.toHaveAttribute('aria-pressed');
  await expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(btn).toHaveAttribute('aria-controls', 'saved-panel');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await page.locator('[data-view=refs]').click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true'); // References kept its Saved view
});
