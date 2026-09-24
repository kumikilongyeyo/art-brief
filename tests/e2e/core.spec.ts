import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const isMobile = (name: string) => name.startsWith('mobile');

/** Record every clipboard write (Clipboard API and execCommand fallback) in window.__copied. */
async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const write = async (t: string) => {
      w.__copied.push(t);
    };
    try {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    } catch {
      /* ignore */
    }
    const exec = document.execCommand.bind(document);
    document.execCommand = (cmd: string, ...rest: unknown[]) => {
      if (cmd === 'copy') {
        const el = document.activeElement as HTMLTextAreaElement | null;
        if (el && 'value' in el) w.__copied.push(el.value);
        return true;
      }
      return exec(cmd, ...(rest as [boolean, string]));
    };
  });
}
const lastCopied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');

const cards = (page: Page) => page.locator('.card:not(.sample)');
const lineText = (page: Page, slot: string, card = 0) => cards(page).nth(card).locator(`.row[data-slot="${slot}"] dd`).innerText();

async function setup(page: Page, opts: { category?: string; count?: number; weirdness?: string } = {}) {
  await captureClipboard(page);
  await page.goto('./');
  if (opts.category) await page.locator(`.pill[data-category="${opts.category}"]`).click();
  if (opts.count) await page.locator(`.seg[aria-label="Variations"] button[data-value="${opts.count}"]`).click();
  if (opts.weirdness) await page.locator(`.seg[aria-label="Weirdness"] button[data-value="${opts.weirdness}"]`).click();
}

async function generate(page: Page) {
  const before = (await page.locator('.card').count()) ? await page.locator('.card').first().getAttribute('data-brief-id') : null;
  await page.locator('#generate').click();
  await expect(page.locator('.card').first()).not.toHaveAttribute('data-brief-id', before ?? '__none__');
  await page.waitForTimeout(160); // Generate is disabled for 150 ms after a press
}

test('first visit shows a sample card', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.card.sample')).toHaveCount(1);
  await expect(page.locator('.card.sample')).toContainText('Sample');
});

test('each category generates the chosen number of cards', async ({ page }) => {
  await setup(page);
  const cats = ['character', 'prop', 'creature', 'building', 'scene'];
  for (const [i, c] of cats.entries()) {
    const n = (i % 4) + 1;
    await page.locator(`.pill[data-category="${c}"]`).click();
    await page.locator(`.seg[aria-label="Variations"] button[data-value="${n}"]`).click();
    await generate(page);
    await expect(cards(page)).toHaveCount(n);
    await expect(cards(page).first().locator('.row[data-slot="palette"] .swatch')).toHaveCount(
      await cards(page).first().locator('.swatch').count(),
    );
  }
  await expect(page.locator('#combo-count')).toContainText('Scene briefs possible');
});

test('Enter and Space generate; a rapid double-click makes one batch', async ({ page }, info) => {
  test.skip(isMobile(info.project.name), 'keyboard test runs on desktop');
  await setup(page, { count: 2 });
  await page.locator('h1').click();
  await page.keyboard.press('Enter');
  await expect(cards(page)).toHaveCount(2);
  const first = await cards(page).first().getAttribute('data-brief-id');
  await page.waitForTimeout(200);
  await page.locator('h1').click();
  await page.keyboard.press(' ');
  await expect(cards(page).first()).not.toHaveAttribute('data-brief-id', first!);
  await expect(page.locator('#list-history summary')).toHaveText('History (4)');
  await page.waitForTimeout(200);
  await page.locator('#generate').dblclick();
  await expect(page.locator('#list-history summary')).toHaveText('History (6)');
});

test('a locked line survives Generate; unlocking lets it change', async ({ page }) => {
  await setup(page, { count: 1 });
  await generate(page);
  const text = await lineText(page, 'background');
  await cards(page).first().getByRole('button', { name: 'Lock Background' }).click();
  await expect(cards(page).first().locator('.row[data-slot="background"]')).toHaveClass(/locked/);
  for (let i = 0; i < 5; i++) {
    await generate(page);
    expect(await lineText(page, 'background')).toBe(text);
  }
  await cards(page).first().getByRole('button', { name: 'Unlock Background' }).click();
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    await generate(page);
    seen.add(await lineText(page, 'background'));
  }
  expect([...seen].some((t) => t !== text)).toBe(true);
});

test('reroll changes only that line (and its dependents)', async ({ page }) => {
  await setup(page, { category: 'creature', count: 1 });
  await generate(page);
  const slots = ['habitat', 'adaptation', 'behaviour', 'scale', 'palette'];
  const read = async () =>
    Object.fromEntries(
      await Promise.all(
        slots.map(async (s) => [s, (await cards(page).first().locator(`.row[data-slot="${s}"]`).count()) ? await lineText(page, s) : '']),
      ),
    );
  const before = await read();
  const title = await cards(page).first().locator('.title').innerText();
  await cards(page).first().getByRole('button', { name: 'Reroll Scale' }).click();
  const after = await read();
  expect(after.scale).not.toBe(before.scale);
  for (const s of ['habitat', 'adaptation', 'behaviour', 'palette']) expect(after[s]).toBe(before[s]);
  expect(await cards(page).first().locator('.title').innerText()).toBe(title);
  // Habitat has a dependent (adaptation): both may change, nothing else does.
  await cards(page).first().getByRole('button', { name: 'Reroll Habitat' }).click();
  const after2 = await read();
  expect(after2.habitat).not.toBe(after.habitat);
  for (const s of ['scale', 'behaviour', 'palette']) expect(after2[s]).toBe(after[s]);
});

test('copy buttons put the expected text on the clipboard', async ({ page }) => {
  await setup(page, { count: 2 });
  await generate(page);
  const first = cards(page).first();
  const title = await first.locator('.title').innerText();
  await first.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await lastCopied(page)).toMatch(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nD&D: [^\\n]+\\nBackground: `));
  await expect(page.locator('.toast')).toHaveText('Copied');
  await first.getByRole('button', { name: 'Copy for ChatGPT' }).click();
  const chat = await lastCopied(page);
  expect(chat).toContain('You are an art director');
  expect(chat).toContain(`BRIEF:\n${title}`);
  await page.locator('#copy-all').click();
  const all = await lastCopied(page);
  expect(all.split('\n\n---\n\n')).toHaveLength(2);
  await page.locator('#copy-all-chat').click();
  expect(await lastCopied(page)).toContain('There are 2 briefs below');
  const swatch = first.locator('.swatch').first();
  const hex = (await swatch.innerText()).trim();
  await swatch.click();
  expect((await lastCopied(page)).toUpperCase()).toBe(hex.toUpperCase());
});

test('real clipboard receives the brief (Chromium, permission granted)', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'chromium', 'clipboard-read permission is Chromium-only');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await generate(page);
  await cards(page).first().getByRole('button', { name: 'Copy', exact: true }).click();
  const title = await cards(page).first().locator('.title').innerText();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(title);
});

test('saved briefs and history survive a reload', async ({ page }) => {
  await setup(page, { count: 1 });
  await generate(page);
  const title = await cards(page).first().locator('.title').innerText();
  await cards(page).first().getByRole('button', { name: 'Save' }).click();
  await expect(cards(page).first().getByRole('button', { name: 'Remove from saved' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('#saved-toggle .badge')).toHaveText('1');
  await page.locator('#saved-toggle').click();
  await expect(page.locator('#saved-panel')).toContainText(title);
  await page.keyboard.press('Escape');
  await expect(page.locator('#saved-panel')).toBeHidden();
  await expect(page.locator('#list-history summary')).toHaveText('History (1)');
  await page.locator('#list-history summary').click();
  await page.locator('#list-history li button').first().click();
  await expect(cards(page).first().locator('.title')).toHaveText(title);
});

test('settings: hide the ChatGPT button, custom instruction is used', async ({ page }) => {
  await setup(page, { count: 1 });
  await generate(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#instruction').fill('Make it moody:\n{{brief}}\nThe end.');
  await page.locator('#instruction').blur();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await cards(page).first().getByRole('button', { name: 'Copy for ChatGPT' }).click();
  const txt = await lastCopied(page);
  expect(txt.startsWith('Make it moody:\n')).toBe(true);
  expect(txt.endsWith('\nThe end.')).toBe(true);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#opt-chatgpt').uncheck();
  await page.keyboard.press('Escape');
  await expect(cards(page).first().getByRole('button', { name: 'Copy for ChatGPT' })).toHaveCount(0);
  await expect(page.locator('#version')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#version')).toContainText(/app .+ · data 2026\.09\.\d+/);
});

test('a share link recreates the exact brief in a fresh context', async ({ page, browser }) => {
  await setup(page, { category: 'scene', count: 3, weirdness: 'wild' });
  await generate(page);
  const card = cards(page).nth(1);
  await card.getByRole('button', { name: 'Reroll Mood' }).click();
  await card.getByRole('button', { name: 'Lock Palette' }).click();
  const expected = await card.innerText();
  await card.getByRole('button', { name: 'Link' }).click();
  const url = await lastCopied(page);
  expect(url).toContain('#c=scene');
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await expect(p2.locator('.card')).toHaveCount(1);
  expect(await p2.locator('.card').innerText()).toBe(expected);
  await expect(p2.locator('.card .row[data-slot="palette"]')).toHaveClass(/locked/);
  await ctx.close();
});

test('a batch link reproduces the batch; bad hashes fall back safely', async ({ page }) => {
  await page.goto('./#c=creature&t=infernal&w=mixed&n=3&s=K7Q2PX&v=2026.09.2');
  await expect(cards(page)).toHaveCount(3);
  const a = await page.locator('.cards').innerText();
  await page.goto('about:blank');
  await page.goto('./#c=creature&t=infernal&w=mixed&n=3&s=K7Q2PX&v=2026.09.2');
  expect(await page.locator('.cards').innerText()).toBe(a);
  await expect(page.locator('#data-notice')).toHaveCount(0);
  await page.goto('about:blank');
  await page.goto('./#c=<script>&t=nope&w=zzz&n=99&s=K7Q2PX&l=habitat:%3Cimg%20src=x%3E&v=2020.01.1');
  await expect(cards(page)).toHaveCount(4);
  await expect(page.locator('#data-notice')).toHaveText('Made with older data; some lines may differ.');
  expect(await page.locator('img[src="x"]').count()).toBe(0);
});

test('a share link pasted into an already-open tab is applied', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => (location.hash = '#c=prop&t=frost&w=grounded&n=3&s=K7Q2PX'));
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('.pill[data-category="prop"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#theme')).toHaveValue('frost');
  expect(await page.evaluate(() => location.hash)).toBe('');
});

test('works when storage is unavailable (private mode)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await captureClipboard(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await expect(page.locator('#storage-notice')).toBeVisible();
  await generate(page);
  await cards(page).first().getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await lastCopied(page)).toContain('Background:');
  await cards(page).first().getByRole('button', { name: 'Save' }).click();
  expect(errors).toEqual([]);
});

test('mobile: no horizontal scroll, controls visible, lock/reroll visible without hover', async ({ page }, info) => {
  test.skip(!isMobile(info.project.name), 'mobile layout test');
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await setup(page, { count: 2, category: 'building' });
    await generate(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const sel of ['#generate', '.pill[data-category="scene"]', '#theme', '.seg[aria-label="Weirdness"]'])
      await expect(page.locator(sel)).toBeInViewport({ ratio: 0.9 });
    const lock = cards(page).first().getByRole('button', { name: 'Lock Setting' });
    expect(await lock.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1');
    const box = await lock.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('accessibility: no axe violations in light and dark mode', async ({ page }, info) => {
  test.skip(isMobile(info.project.name), 'desktop only');
  await page.goto('./');
  await generate(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Reveal hover-only controls so their contrast is checked too.
    await page.addStyleTag({ content: '.actions{opacity:1!important} *{animation:none!important;transition:none!important}' });
    await page.waitForTimeout(50);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      r.violations.map(
        (v) =>
          `${scheme}: ${v.id} — ${v.nodes
            .map((n) => n.target.join(' '))
            .slice(0, 3)
            .join(', ')}`,
      ),
    ).toEqual([]);
  }
  await page.getByRole('button', { name: 'Settings' }).click();
  const r = await new AxeBuilder({ page }).include('.panel').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
});

test('keyboard-only walkthrough with visible focus', async ({ page }, info) => {
  test.skip(isMobile(info.project.name) || info.project.name === 'webkit', 'Safari skips buttons on Tab by default');
  await captureClipboard(page);
  await page.goto('./');
  const focusVisible = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      return el !== document.body && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
  await page.keyboard.press('Tab'); // Saved (header)
  expect(await focusVisible()).toBe(true);
  await page.keyboard.press('Tab'); // settings
  await page.keyboard.press('Tab'); // Character pill
  await page.keyboard.press('Tab'); // Prop pill
  await page.keyboard.press('Enter');
  await expect(page.locator('.pill[data-category="prop"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await focusVisible()).toBe(true);
  // Jump to Generate with Tab until it is focused
  for (let i = 0; i < 15 && !(await page.evaluate(() => document.activeElement?.id === 'generate')); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(cards(page).first()).toBeVisible();
  for (
    let i = 0;
    i < 10 && !(await page.evaluate(() => (document.activeElement as HTMLElement)?.getAttribute('aria-label')?.startsWith('Lock')));
    i++
  )
    await page.keyboard.press('Tab');
  expect(await focusVisible()).toBe(true);
  await page.keyboard.press(' ');
  await expect(page.locator(':focus')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page).first().locator('.row.locked')).toHaveCount(1);
});
