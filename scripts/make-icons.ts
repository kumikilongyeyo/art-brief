/** Render the PWA PNG icons from an inline SVG using Playwright's Chromium. Run: npx tsx scripts/make-icons.ts */
import { chromium } from '@playwright/test';

const mark = (size: number, pad: number) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${pad ? 0 : 14}" fill="#4c35b5"/>
  <g transform="translate(32 32) scale(${pad ? 0.72 : 1}) translate(-32 -32)">
    <rect x="20" y="20" width="24" height="24" rx="3" transform="rotate(45 32 32)" fill="none" stroke="#fff" stroke-width="5"/>
    <circle cx="32" cy="32" r="4" fill="#fff"/>
  </g>
</svg>`;

const jobs: [string, number, number][] = [
  ['public/pwa-192.png', 192, 0],
  ['public/pwa-512.png', 512, 0],
  ['public/pwa-maskable-512.png', 512, 1],
  ['public/apple-touch-icon.png', 180, 1],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [out, size, pad] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#4c35b5">${mark(size, pad)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: false });
  console.log('wrote', out);
}
await browser.close();
