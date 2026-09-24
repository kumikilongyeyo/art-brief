import { expect, test } from '@playwright/test';

// Checks that only make sense against the deployed site. Run with:
//   E2E_BASE_URL=https://kumikilongyeyo.github.io/art-brief/ npx playwright test tests/e2e/live.spec.ts --project=chromium
test.skip(() => !process.env.E2E_BASE_URL || test.info().project.name !== 'chromium', 'live-site checks');

test('assets load under the Pages base path (no 404s)', async ({ page }) => {
  const bad: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
  });
  await page.goto('./');
  await expect(page.locator('h1')).toHaveText('What do you want to create?');
  for (const f of [
    'manifest.webmanifest',
    'sw.js',
    'pwa-192.png',
    'pwa-512.png',
    'pwa-maskable-512.png',
    'apple-touch-icon.png',
    'favicon.svg',
  ]) {
    const r = await page.request.get(f);
    expect(r.status(), f).toBe(200);
  }
  expect(bad).toEqual([]);
});

test('installable: manifest is valid and Chrome reports no installability errors', async ({ page }) => {
  await page.goto('./');
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ short_name: 'Art Brief', start_url: './', scope: './', display: 'standalone' });
  expect(manifest.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}${i.purpose ? ' ' + i.purpose : ''}`)).toEqual(
    expect.arrayContaining(['192x192', '512x512', '512x512 maskable']),
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#generate').click();
  await expect(page.locator('.card:not(.sample)')).not.toHaveCount(0);
  await context.setOffline(false);
});
