import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

test.describe('PWA', () => {
  test.skip(() => test.info().project.name !== 'chromium', 'service worker tests run in desktop Chromium');

  test('works offline after the first visit', async ({ page, context }) => {
    await page.goto('./');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('h1')).toHaveText('What do you want to create?');
    await page.locator('#generate').click();
    await expect(page.locator('.card:not(.sample)')).toHaveCount(2);
    await context.setOffline(false);
  });

  test.describe('update flow', () => {
    test.skip(() => !!process.env.E2E_BASE_URL, 'local A/B builds only; live.spec.ts covers the deployed site');
    let server: ChildProcess;
    const PORT = 4180;
    test.beforeAll(async () => {
      if (test.info().project.name !== 'chromium') return;
      test.setTimeout(120_000);
      for (const v of ['a', 'b']) {
        execSync(`npx vite build --logLevel error`, {
          cwd: ROOT,
          env: { ...process.env, APP_VERSION: `1.0.0-${v}`, OUT_DIR: `dist-${v}` },
          stdio: 'inherit',
        });
      }
      server = spawn(process.execPath, [join(HERE, 'switch-server.mjs'), String(PORT), ROOT], { stdio: 'inherit' });
      await new Promise((r) => setTimeout(r, 500));
    });
    test.afterAll(() => server?.kill());

    test('new build shows the update pill; refreshing loads the new version', async ({ page, request }) => {
      const base = `http://localhost:${PORT}/art-brief/`;
      await request.get(`http://localhost:${PORT}/__switch?to=a`);
      await page.goto(base);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await expect(page.locator('footer')).toContainText('app 1.0.0-a');
      await request.get(`http://localhost:${PORT}/__switch?to=b`);
      await page.reload();
      await expect(page.locator('#update-pill')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#update-pill')).toHaveText('New version — Refresh');
      await page.locator('#update-pill').click();
      await expect(page.locator('footer')).toContainText('app 1.0.0-b', { timeout: 15_000 });
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.locator('#version')).toContainText('app 1.0.0-b');
    });
  });
});
