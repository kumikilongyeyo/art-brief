import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4173);
// E2E_BASE_URL=https://kumikilongyeyo.github.io/art-brief/ runs the suite against the live site.
const LIVE = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: LIVE || `http://localhost:${PORT}/art-brief/`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: LIVE
    ? undefined
    : {
        command: `npx vite preview --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/art-brief/`,
        reuseExistingServer: !process.env.CI,
      },
});
