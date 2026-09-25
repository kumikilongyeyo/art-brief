import { expect, test, type Page } from '@playwright/test';

const cards = (page: Page) => page.locator('.card:not(.sample)');
const saved = (page: Page) => page.locator('#saved-panel');
/** Open the header Saved dropdown if it is closed. */
async function openSaved(page: Page) {
  if (await page.locator('#saved-panel').isHidden()) await page.locator('#saved-toggle').click();
  await expect(page.locator('#saved-panel')).toBeVisible();
}
const history = (page: Page) => page.locator('#list-history');
const showVar = (page: Page, i: number) => page.locator('.var-tab').nth(i).click();

async function start(page: Page, n = 3) {
  await page.goto('./');
  await page.locator(`.seg[aria-label="Variations"] button[data-value="${n}"]`).click();
  await page.locator('#generate').click();
  await expect(cards(page)).toHaveCount(n);
  await history(page).locator('summary').click();
}

test('save into folders, move with the folder menu, filter by chip', async ({ page }) => {
  await start(page);
  // Save from a card → Unsorted; a folder button appears next to Save.
  await cards(page).nth(0).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Saved to Unsorted');
  const folderBtn = cards(page)
    .nth(0)
    .getByRole('button', { name: /Move to folder/ });
  await expect(folderBtn).toContainText('Unsorted');

  // Create a folder from the card's menu and move the brief into it in one go.
  await folderBtn.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  await page.getByLabel('New folder name', { exact: true }).fill('Villains');
  await page.getByLabel('New folder name', { exact: true }).press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(
    cards(page)
      .nth(0)
      .getByRole('button', { name: /Move to folder/ }),
  ).toContainText('Villains');
  await openSaved(page);
  await expect(saved(page).locator('.chip[data-filter="all"] .chip-count')).toHaveText('1');

  // Viewing a folder makes it the save target.
  await saved(page).locator('.chip', { hasText: 'Villains' }).click();
  await showVar(page, 1);
  await cards(page).nth(1).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Saved to Villains');
  await expect(page.locator('#saved-panel')).toBeHidden(); // clicking outside closed the dropdown
  await openSaved(page);
  await expect(saved(page).locator('.item')).toHaveCount(2);

  // Move one back to Unsorted from the saved list (keyboard: arrow + Enter).
  await saved(page)
    .locator('.item')
    .first()
    .getByRole('button', { name: /Move to folder/ })
    .click();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitemradio', { name: 'Unsorted' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(saved(page).locator('.item')).toHaveCount(1);
  await saved(page).locator('.chip[data-filter="unsorted"]').click();
  await expect(saved(page).locator('.item')).toHaveCount(1);

  // Survives a reload, folders and all.
  await page.reload();
  await openSaved(page);
  await expect(saved(page).locator('.chip', { hasText: 'Villains' }).locator('.chip-count')).toHaveText('1');
  await expect(saved(page).locator('.chip[data-filter="unsorted"]')).toHaveAttribute('aria-pressed', 'true');
});

test('remove with undo, clear history keeps saved', async ({ page }) => {
  await start(page, 2);
  await history(page).locator('.item').first().getByRole('button', { name: 'Save' }).click();
  await expect(history(page).locator('.item').first().getByRole('button', { name: 'Remove from saved' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await openSaved(page);
  await expect(saved(page).locator('.item')).toHaveCount(1);

  // Remove from saved → Undo brings it back.
  await saved(page).locator('.item').first().getByRole('button', { name: 'Remove from saved' }).click();
  await expect(saved(page).locator('.item')).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(saved(page).locator('.item')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Remove one history entry, undo it.
  await history(page).locator('.item').nth(1).getByRole('button', { name: 'Remove from history' }).click();
  await expect(history(page).locator('summary')).toHaveText('History (1)');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(history(page).locator('summary')).toHaveText('History (2)');

  // Clear history: saved stays.
  await history(page).getByRole('button', { name: 'Clear history' }).click();
  await expect(history(page).locator('summary')).toHaveText('History (0)');
  await expect(page.locator('.toast')).toContainText('saved briefs kept');
  await expect(page.locator('#saved-toggle .badge')).toHaveText('1');
  await page.reload();
  await expect(page.locator('#saved-toggle .badge')).toHaveText('1');
  await expect(page.locator('#list-history summary')).toHaveText('History (0)');
});

test('rename and delete a folder (briefs move to Unsorted, undo restores)', async ({ page }) => {
  await start(page, 2);
  await openSaved(page);
  await saved(page).getByRole('button', { name: 'New folder', exact: true }).click();
  await saved(page).getByLabel('New folder name', { exact: true }).fill('Props');
  await saved(page).getByLabel('New folder name', { exact: true }).press('Enter');
  await expect(saved(page).locator('.chip[aria-pressed="true"]')).toContainText('Props');
  await cards(page).nth(0).getByRole('button', { name: 'Save', exact: true }).click();
  await showVar(page, 1);
  await cards(page).nth(1).getByRole('button', { name: 'Save', exact: true }).click();
  await openSaved(page);
  await expect(saved(page).locator('.item')).toHaveCount(2);

  await saved(page).getByRole('button', { name: 'Rename folder Props' }).click();
  await saved(page).getByLabel('Rename folder', { exact: true }).fill('Relics');
  await saved(page).getByLabel('Rename folder', { exact: true }).press('Enter');
  await expect(saved(page).locator('.folder-current')).toHaveText('Relics');

  await saved(page).getByRole('button', { name: 'Delete folder Relics' }).click();
  await expect(page.locator('.toast')).toContainText('2 moved to Unsorted');
  await expect(saved(page).locator('.chip', { hasText: 'Relics' })).toHaveCount(0);
  await expect(saved(page).locator('.chip[data-filter="unsorted"] .chip-count')).toHaveText('2');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(saved(page).locator('.chip', { hasText: 'Relics' }).locator('.chip-count')).toHaveText('2');
});

test('Saved opens from the header and closes with Esc or an outside click', async ({ page }) => {
  await start(page, 1);
  await expect(page.locator('#saved-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#saved-toggle').click();
  await expect(saved(page)).toBeVisible();
  await expect(page.locator('#saved-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(saved(page)).toBeHidden();
  await expect(page.locator('#saved-toggle')).toBeFocused();
  await page.locator('#saved-toggle').click();
  const vp = page.viewportSize()!;
  await page.mouse.click(4, vp.height - 4); // a spot the dropdown doesn't cover
  await expect(saved(page)).toBeHidden();
  // Saving from a card pulses the header count.
  await cards(page).nth(0).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#saved-toggle .badge')).toHaveText('1');
  await expect(page.locator('#saved-toggle')).toHaveClass(/pulse/);
});

test('drag a saved brief onto a folder chip (desktop)', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('mobile'), 'drag and drop is a desktop shortcut; phones use the folder button');
  await start(page, 1);
  await openSaved(page);
  await saved(page).getByRole('button', { name: 'New folder', exact: true }).click();
  await saved(page).getByLabel('New folder name', { exact: true }).fill('Keepers');
  await saved(page).getByLabel('New folder name', { exact: true }).press('Enter');
  await saved(page).locator('.chip[data-filter="all"]').click();
  await page.keyboard.press('Escape');
  await history(page).locator('.item').first().getByRole('button', { name: 'Save' }).click();
  await openSaved(page);
  // Chromium needs a stepped, hand-like drag to start an HTML drag in the dropdown; WebKit's test driver
  // only supports Playwright's dragTo. Try the stepped drag first, then dragTo.
  const keepers = saved(page).locator('.chip', { hasText: 'Keepers' });
  const src = (await saved(page).locator('.item-main').first().boundingBox())!;
  const dst = (await keepers.boundingBox())!;
  await page.mouse.move(src.x + 20, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y + src.height / 2, { steps: 5 });
  await page.mouse.move(dst.x + 10, dst.y + 10, { steps: 10 });
  await page.mouse.up();
  if ((await keepers.locator('.chip-count').innerText()) !== '1') await saved(page).locator('.item-main').first().dragTo(keepers);
  await expect(saved(page).locator('.chip', { hasText: 'Keepers' }).locator('.chip-count')).toHaveText('1');
});

test('library fits a phone screen: no sideways scroll, all action buttons visible', async ({ page }, info) => {
  test.skip(!info.project.name.startsWith('mobile'), 'phone layout');
  await start(page, 2);
  await openSaved(page);
  for (let i = 0; i < 4; i++) {
    await saved(page).getByRole('button', { name: 'New folder', exact: true }).click();
    await saved(page)
      .getByLabel('New folder name', { exact: true })
      .fill(`Folder number ${i + 1}`);
    await saved(page).getByLabel('New folder name', { exact: true }).press('Enter');
  }
  await cards(page).nth(0).getByRole('button', { name: 'Save', exact: true }).click();
  await openSaved(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const n of ['Remove from saved', 'Move to folder', 'Rename folder', 'Delete folder']) {
    const t = saved(page)
      .getByRole('button', { name: new RegExp(n) })
      .first();
    await t.scrollIntoViewIfNeeded();
    await expect(t).toBeInViewport({ ratio: 1 }); // fully on screen, not clipped at the right edge
  }
  await page.keyboard.press('Escape');
  const h = history(page).getByRole('button', { name: 'Remove from history' }).first();
  await h.scrollIntoViewIfNeeded();
  await expect(h).toBeInViewport({ ratio: 1 });
});
