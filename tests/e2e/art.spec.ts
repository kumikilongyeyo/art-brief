import { expect, test, type Page } from '@playwright/test';

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void w.__copied.push(t) },
      configurable: true,
    });
  });
}
const lastCopied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');
const card = (page: Page) => page.locator('.card:not(.sample)').first();

test('cards read like a studio assignment; D&D extras are off by default', async ({ page }) => {
  await captureClipboard(page);
  await page.goto('./');
  await page.locator('.pill[data-category="creature"]').click();
  await page.getByLabel('Add a short story to each card').check();
  await page.locator('#generate').click();
  await expect(card(page).locator('.overline')).toHaveText(/ · Creature · #[0-9A-Z]{6}-\d$/i);
  // General info first: the ask and the story are visible, technical direction is folded.
  await expect(card(page).locator('.ask-line')).toContainText('The ask');
  await expect(card(page).locator('.lore-text')).toBeVisible();
  const art = card(page).locator('.art');
  await expect(art).not.toHaveAttribute('open', '');
  await expect(art.locator('.art-title')).toHaveText('Technical direction');
  await art.locator('summary').click();
  for (const label of ['Shape', 'Focal point', 'Light & value', 'Camera'])
    await expect(art.locator('dt', { hasText: label })).toHaveCount(1);
  await expect(art.locator('.deliverable')).toContainText(/about \d+ (hours|minutes)/);
  await expect(art.locator('.ad-note')).toContainText('AD note');
  await expect(card(page).locator('.moment')).toContainText('Moment to paint');
  // Art-first: no stat line, dice chips or DM notes.
  await expect(card(page).locator('.stat, .roll, .hook')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Copy', exact: true }).click();
  const text = await lastCopied(page);
  expect(text).toContain('\nShape: ');
  expect(text).toContain('\nDeliverables: ');
  expect(text).toContain('\nMoment to paint: ');
  expect(text).not.toContain('\nD&D: ');
  expect(text).not.toContain('\nJob: ');

  // Another take on the direction keeps the brief itself.
  const title = await card(page).locator('.title').innerText();
  const before = await art.locator('.art-lines').innerText();
  let changed = false;
  for (let i = 0; i < 4 && !changed; i++) {
    await card(page).getByRole('button', { name: 'Reroll art direction' }).click();
    // The card re-renders with the fold closed; open it again to read the new take.
    if ((await card(page).locator('.art').getAttribute('open')) === null) await card(page).locator('.art summary').click();
    changed = (await card(page).locator('.art .art-lines').innerText()) !== before;
  }
  expect(changed).toBe(true);
  await expect(card(page).locator('.title')).toHaveText(title);
  // A share link keeps that take on the direction.
  const direction = await card(page).locator('.art .art-lines').innerText();
  await card(page).getByRole('button', { name: 'Link' }).click();
  const url = await lastCopied(page);
  expect(url).toContain('ar=');
  const p2 = await page.context().browser()!.newPage();
  await p2.goto(url);
  await p2.locator('.card .art summary').click();
  await expect(p2.locator('.card .art .art-lines')).toBeVisible();
  expect(await p2.locator('.card .art .art-lines').innerText()).toBe(direction);
  await p2.close();
});

test('the D&D details switch brings back stat line, dice and DM notes', async ({ page }) => {
  await captureClipboard(page);
  await page.goto('./');
  await page.getByLabel('Add a short story to each card').check();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#opt-dnd').check();
  await page.keyboard.press('Escape');
  await page.locator('#generate').click();
  await expect(card(page).locator('.stat')).toBeVisible();
  await expect(card(page).locator('.roll').first()).toBeVisible();
  const notes = card(page).locator('.hook');
  const notesSummary = card(page).locator('.hook > summary');
  await expect(notesSummary).toHaveText('DM notes');
  await notesSummary.click();
  await expect(notes.locator('.hook-row', { hasText: 'Job' })).toBeVisible();
  await card(page).getByRole('button', { name: 'Copy', exact: true }).click();
  const text = await lastCopied(page);
  expect(text).toContain('\nD&D: ');
  expect(text).toContain('\nJob: ');
});
