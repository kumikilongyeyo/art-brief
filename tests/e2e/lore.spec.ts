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
const cards = (page: Page) => page.locator('.card:not(.sample)');
/** Open one of a card's collapsed rows (Every detail / Story / Direction) if it is closed. */
async function openSection(card: Locator, section: 'details' | 'story' | 'direction') {
  const d = card.locator(`.acc[data-section="${section}"]`);
  if ((await d.getAttribute('open')) === null) await d.locator('> summary').click();
  await expect(d).toHaveAttribute('open', '');
}

test('Lore tickbox adds a story to every card and is remembered', async ({ page }) => {
  await captureClipboard(page);
  await page.goto('./');
  await page.locator('.seg[aria-label="Variations"] button[data-value="3"]').click();
  await page.getByLabel('Add a short story to each card').check();
  await page.locator('#generate').click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).locator('.lore-text')).toHaveCount(3);
  const words = (await cards(page).first().locator('.lore-text').textContent())!.trim().split(/\s+/).length;
  expect(words).toBeGreaterThanOrEqual(50);
  expect(words).toBeLessThanOrEqual(80);
  await page.reload();
  await expect(page.getByLabel('Add a short story to each card')).toBeChecked();
});

test('per-card lore: add, reroll, hide, copy, refine, share', async ({ page, browser }) => {
  await captureClipboard(page);
  await page.goto('./');
  await page.locator('.pill[data-category="prop"]').click();
  await page.locator('.seg[aria-label="Variations"] button[data-value="2"]').click();
  await page.locator('#generate').click();
  const card = cards(page).first();
  await expect(card.locator('.lore')).toHaveCount(0);
  await openSection(card, 'story');
  await card.getByRole('button', { name: 'Add lore' }).click();
  const first = await card.locator('.lore-text').innerText();
  expect(first.length).toBeGreaterThan(100);
  await expect(cards(page).nth(1).locator('.lore')).toHaveCount(0);

  await card.getByRole('button', { name: 'Reroll lore' }).click();
  await expect(card.locator('.lore-text')).not.toHaveText(first);
  const story = await card.locator('.lore-text').innerText();

  // Rerolling a line keeps the story on the card.
  await openSection(card, 'details');
  await card.getByRole('button', { name: 'Reroll Function' }).click();
  await expect(card.locator('.lore-text')).toHaveCount(1);
  const afterReroll = await card.locator('.lore-text').innerText();

  await card.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await lastCopied(page)).toContain(`\n\nLore: ${afterReroll}`);
  await card.getByRole('button', { name: 'Refine story in ChatGPT' }).click();
  const prompt = await lastCopied(page);
  expect(prompt).toContain('LORE DRAFT:');
  expect(prompt).toContain(afterReroll);

  await card.getByRole('button', { name: 'Link' }).click();
  const url = await lastCopied(page);
  expect(url).toContain('lo=1');
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await expect(p2.locator('.card .lore-text')).toHaveText(afterReroll);
  await ctx.close();

  await card.getByRole('button', { name: 'Hide lore' }).click();
  await expect(card.locator('.lore')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Add lore' })).toBeVisible();
  expect(story.length).toBeGreaterThan(0);
});
