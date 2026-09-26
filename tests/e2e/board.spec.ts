import { expect, test, type Page } from '@playwright/test';
import { fakeWeb } from './refs-fake';

// The reference board on a brief card, with every outside site faked (refs-fake.ts) and the real ranking model.

const board = (page: Page) => page.locator('.card:not([hidden]):not(.sample) .rb');
const tiles = (page: Page) => board(page).locator('.rb-tile:not(.rb-wait)');

async function generate(page: Page, category = 'Character') {
  await page.goto('./');
  await page.getByRole('button', { name: category, exact: true }).click();
  await page.locator('#generate').click();
  await expect(board(page)).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(tiles(page).first()).toBeVisible();
}

test.describe('reference board', () => {
  // each board runs the real ranking model on ~100 pictures: side by side they starve each other (WebKit's
  // single-threaded wasm most), which no user's one tab ever does
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => fakeWeb(page));

  // The fake sites have 12 distinct pictures between them, and the board refuses near-copies of what it
  // shows: a faked board can stop short of the 5 a real one reaches, so 3 is the floor here.
  test('fills with labelled pictures (at most 10), subject first, for every category', async ({ page }, info) => {
    // five boards of searches in a row, beside the other tests, outrun the faked sites' replies on WebKit's
    // single-threaded model (alone it passes); the searches are the same code in every browser
    test.skip(info.project.name !== 'chromium', 'Chromium covers the searches');
    for (const cat of ['Character', 'Creature', 'Prop', 'Building', 'Scene']) {
      await generate(page, cat);
      const n = await tiles(page).count();
      expect(n, `${cat} ${await board(page).getAttribute('data-parts')}`).toBeGreaterThanOrEqual(3);
      expect(n, cat).toBeLessThanOrEqual(10);
      // the subject leads (with only the faked sites it can come up empty; then the next part does)
      const labels = await tiles(page).locator('.rb-lab').allTextContents();
      if (labels.includes('Subject')) expect(labels.lastIndexOf('Subject'), cat).toBe(labels.filter((l) => l === 'Subject').length - 1);
      await expect(board(page).locator('.rb-count')).toHaveText(` · ${n}`);
    }
  });

  test('keep, swap and remove a picture; the viewer shows where it is from', async ({ page }) => {
    await generate(page);
    const first = tiles(page).first();
    await first.hover();
    await first.getByRole('button', { name: 'Keep this one' }).click();
    await expect(tiles(page).first()).toHaveClass(/locked/);

    // swap a picture whose part has another to offer (data-parts: part:shown/spares/found)
    const parts = (await board(page).getAttribute('data-parts'))!.split(' ').map((x) => x.split(':'));
    const withSpare = parts.find(([, n]) => +n.split('/')[1] > 0)?.[0];
    if (withSpare) {
      const t = tiles(page).and(page.locator(`[data-part="${withSpare}"]`)).last();
      const before = await t.locator('img').getAttribute('src');
      await t.hover();
      await t.getByRole('button', { name: 'Swap for another' }).click();
      await expect(tiles(page).and(page.locator(`[data-part="${withSpare}"]`)).locator(`img[src="${before}"]`)).toHaveCount(0);
    }

    const n = await tiles(page).count();
    await tiles(page).last().hover();
    await tiles(page).last().getByRole('button', { name: 'Remove' }).click();
    await expect(tiles(page)).toHaveCount(n - 1);

    await tiles(page).nth(2).click();
    const view = page.locator('dialog.rb-view');
    await expect(view).toBeVisible();
    await expect(view.getByRole('link', { name: /^Open on / })).toHaveAttribute('href', /^https:\/\//);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
  });

  test('a saved brief keeps its board, and reopens it without searching again', async ({ page }) => {
    await generate(page);
    await tiles(page).first().hover();
    await tiles(page).first().getByRole('button', { name: 'Keep this one' }).click();
    const srcs = await tiles(page).locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    await page.locator('.card:not([hidden]):not(.sample)').getByRole('button', { name: 'Save', exact: true }).click();

    await page.reload();
    let searched = 0;
    page.on('request', (r) => {
      if (/api\.openverse\.org\/v1\/images\/\?/.test(r.url())) searched++;
    });
    await page.locator('#saved-toggle').click();
    await page.locator('#saved-panel').getByRole('button').filter({ hasText: /—/ }).first().click();
    await expect(tiles(page)).toHaveCount(srcs.length);
    await expect(tiles(page).first()).toHaveClass(/locked/);
    expect(await tiles(page).locator('img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src))).toEqual(srcs);
    await page.waitForTimeout(1500);
    expect(searched).toBe(0);
  });

  test('downloads a PureRef board with every picture and the brief as a note', async ({ page }) => {
    await generate(page);
    const n = await tiles(page).count();
    const [dl] = await Promise.all([page.waitForEvent('download'), board(page).getByRole('button', { name: 'PureRef' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.pur$/);
    const stream = await dl.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const b = Buffer.concat(chunks);
    expect(b.subarray(4, 12).swap16().toString('utf16le')).toBe('1.10');
    expect(b.readUInt16BE(14)).toBe(n); // images
    expect(b.readUInt16BE(12)).toBe(n + 1); // …and the note
  });
});
