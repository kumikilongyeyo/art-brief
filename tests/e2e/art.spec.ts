import { expect, test, type Locator, type Page } from '@playwright/test';

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
/** Open one of a card's collapsed rows (Every detail / Story / Direction) if it is closed. */
async function openSection(card: Locator, section: 'details' | 'story' | 'direction') {
  const d = card.locator(`.acc[data-section="${section}"]`);
  if ((await d.getAttribute('open')) === null) await d.locator('> summary').click();
  await expect(d).toHaveAttribute('open', '');
}

test('cards read like a studio assignment; D&D extras are off by default', async ({ page }) => {
  await captureClipboard(page);
  await page.goto('./');
  await page.locator('.pill[data-category="creature"]').click();
  await page.getByLabel('Add a short story to each card').check();
  await page.locator('#generate').click();
  // Read it like a note: job + deadline chips, name, a plain summary, palette and the moment to paint.
  await expect(card(page).locator('.job-chip')).not.toBeEmpty();
  await expect(card(page).locator('.due-chip')).toContainText(/Due in \d+ (day|days|week|weeks)/);
  await expect(card(page).locator('.note')).toContainText(' is ');
  await expect(card(page).locator('.dot').first()).toBeVisible();
  await expect(card(page).locator('.moment')).toBeVisible();
  // Everything else is folded into three rows.
  for (const s of ['details', 'story', 'direction'])
    await expect(card(page).locator(`.acc[data-section="${s}"]`)).not.toHaveAttribute('open', '');
  await expect(card(page).locator('.lore-text')).toBeHidden();
  await openSection(card(page), 'story');
  await expect(card(page).locator('.lore-text')).toBeVisible();
  await openSection(card(page), 'details');
  await expect(card(page).locator('.ask-line')).toContainText('The ask');
  const art = card(page).locator('.acc[data-section="direction"]');
  await expect(art.locator('summary b')).toHaveText('Direction');
  await openSection(card(page), 'direction');
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
    // The re-rendered card keeps the row open.
    await expect(art).toHaveAttribute('open', '');
    changed = (await art.locator('.art-lines').innerText()) !== before;
  }
  expect(changed).toBe(true);
  await expect(card(page).locator('.title')).toHaveText(title);
  // A share link keeps that take on the direction.
  const direction = await art.locator('.art-lines').innerText();
  await card(page).getByRole('button', { name: 'Link' }).click();
  const url = await lastCopied(page);
  expect(url).toContain('ar=');
  const p2 = await page.context().browser()!.newPage();
  await p2.goto(url);
  await openSection(p2.locator('.card'), 'direction');
  expect(await p2.locator('.card .art-lines').innerText()).toBe(direction);
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
  await openSection(card(page), 'details');
  await expect(card(page).locator('.roll').first()).toBeVisible();
  await openSection(card(page), 'story');
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

test('Job selector: chosen job on every card, unfitting jobs greyed, falls back on category switch', async ({ page }) => {
  await page.goto('./');
  await page.locator('.seg[aria-label="Variations"] button[data-value="3"]').click();
  await page.locator('#job').selectOption('tcg');
  await page.locator('#generate').click();
  const jobs = page.locator('.card:not(.sample) .job-chip');
  await expect(jobs).toHaveCount(3);
  for (const t of await jobs.allTextContents()) expect(t.toLowerCase()).toContain('tcg card art');
  await expect(page.locator('.card:not(.sample) .due-chip').first()).toContainText(/Due in \d+ (day|days|week|weeks)/);

  // Remembered across reloads.
  await page.reload();
  await expect(page.locator('#job')).toHaveValue('tcg');

  // 3D turnaround isn't offered for scenes: greyed out, and picking Scene while it's selected falls back.
  await page.locator('#job').selectOption('turnaround');
  await page.locator('.pill[data-category="scene"]').click();
  await expect(page.locator('#job')).toHaveValue('any');
  await expect(page.locator('#job option[value="turnaround"]')).toBeDisabled();
  await expect(page.locator('.toast')).toContainText("isn't offered for scenes");
});
