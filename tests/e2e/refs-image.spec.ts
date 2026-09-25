import { expect, test, type Page } from '@playwright/test';
import { cells, cropBox, dragOnImage, dropFile, fakeWeb, fixture, openRefs, paste, png, search } from './refs-fake';

// Searching with your own image: how it's read (a pose, or a picture), the crop box, the joint dots, and
// what happens when a new image arrives while you're busy with the last one.

test.describe.configure({ timeout: 90_000 });
test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'model-heavy: desktop Chromium only');

const HOUSE = `x.lineWidth = 4;
  x.strokeRect(100, 130, 200, 140);
  x.beginPath(); x.moveTo(85, 135); x.lineTo(200, 45); x.lineTo(315, 135); x.closePath(); x.stroke();
  x.strokeRect(125, 160, 40, 40); x.strokeRect(235, 160, 40, 40); x.strokeRect(180, 200, 40, 70);
  x.beginPath(); x.moveTo(20, 272); x.lineTo(380, 272); x.stroke();`;
const upload = (page: Page, name: string, mimeType: string, buffer: Buffer) => page.setInputFiles('#r-file', { name, mimeType, buffer });
const stick = (page: Page) => upload(page, 'stick.png', 'image/png', fixture('stick-arms-up.png'));
/** Decoding a pasted or chosen file (only the one called `name`, if given) takes `ms` longer: a huge photo. */
const slowDecode = (page: Page, ms: number, name = '') =>
  page.evaluate(
    ([ms, name]) => {
      const decode = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
      (window as { createImageBitmap: unknown }).createImageBitmap = async (s: unknown, ...rest: unknown[]) => {
        if (s instanceof File && (!name || s.name === name)) await new Promise((r) => setTimeout(r, ms));
        return decode(s, ...rest);
      };
    },
    [ms, name] as const,
  );
async function pickMode(page: Page, name: string) {
  await page.locator('#r-modebtn').click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator('#r-modebtn')).toContainText(name);
}
/** Marks the results on screen, so a test can tell whether a search replaced them. */
const markResults = (page: Page) => page.evaluate(() => ((globalThis as { __cell?: Element }).__cell = document.querySelector('.r-grid .r-cell')!));
const resultsKept = (page: Page) => page.evaluate(() => !!(globalThis as { __cell?: Element }).__cell?.isConnected);

test('a line drawing in Place mode is searched by how it looks, not as a stick figure', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await pickMode(page, 'Place');
  await upload(page, 'house.png', 'image/png', await png(page, 400, 300, HOUSE));
  await expect(page.locator('.r-reading')).toContainText('how this drawing looks', { timeout: 20_000 });
  await expect(page.locator('.r-joint')).toHaveCount(0);
  await expect(page.locator('#r-modebtn')).toContainText('Place');
  // the same drawing in Pose mode is a figure to pose
  await pickMode(page, 'Pose');
  await expect(page.locator('.r-joint')).toHaveCount(11, { timeout: 20_000 });
});

test('line art with a transparent background is read as a drawing, and shown on white', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  // the fixture stick figure with its white paper made see-through
  const clear = await page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height),
      x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i + 3] = 255 - d.data[i];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 0;
    }
    x.putImageData(d, 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let s = '';
    for (const v of buf) s += String.fromCharCode(v);
    return btoa(s);
  }, fixture('stick-arms-up.png').toString('base64'));
  await upload(page, 'clear.png', 'image/png', Buffer.from(clear, 'base64'));
  await expect(page.locator('.r-joint')).toHaveCount(11, { timeout: 20_000 });
  await expect(page.locator('.r-reading')).toContainText(/pose/i);
  expect(await page.locator('.r-imgwrap img').evaluate((i) => getComputedStyle(i).backgroundColor)).toBe('rgb(255, 255, 255)');
});

test('dragging across the picture draws the search area', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await upload(page, 'photo.jpg', 'image/jpeg', fixture('0.jpg'));
  await expect(page.locator('.r-crop')).toBeVisible();
  await dragOnImage(page, [0.25, 0.2], [0.75, 0.7]);
  expect(await cropBox(page)).toEqual({ x: 0.25, y: 0.2, w: 0.5, h: 0.5 });
  await expect(page.getByRole('button', { name: 'Use whole image' })).toHaveAttribute('aria-pressed', 'false');
  // and outside the box, a new one
  await dragOnImage(page, [0.8, 0.8], [0.95, 0.95]);
  const b = await cropBox(page);
  expect(b.x).toBeCloseTo(0.8, 1);
  expect(b.y).toBeCloseTo(0.8, 1);
});

test('the Head dot drags the head, not the neck under it', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await stick(page);
  const head = page.locator('.r-joint[aria-label^="Head"]'),
    neck = page.locator('.r-joint[aria-label^="Neck"]');
  await expect(head).toBeVisible({ timeout: 20_000 });
  const [h0, n0] = [await head.getAttribute('style'), await neck.getAttribute('style')];
  const b = (await head.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2 - 20, { steps: 6 });
  await page.mouse.up();
  expect(await head.getAttribute('style')).not.toBe(h0);
  expect(await neck.getAttribute('style')).toBe(n0);
});

test('arrow keys on a joint or the crop box keep focus through the new search', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await stick(page);
  const hand = page.locator('.r-joint[aria-label^="Hand"]');
  await expect(hand).toBeVisible({ timeout: 20_000 });
  await hand.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1500); // the search runs 600 ms after the last key
  await expect(hand).toBeFocused();
  const before = await hand.getAttribute('style');
  await page.keyboard.press('ArrowDown');
  expect(await hand.getAttribute('style')).not.toBe(before);
  const crop = page.locator('.r-crop');
  await crop.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(1500);
  await expect(crop).toBeFocused();
});

test('clicks that change nothing keep the results', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await stick(page);
  await expect(cells(page).first()).toBeVisible({ timeout: 30_000 });
  await markResults(page);
  await page.getByRole('button', { name: 'Use whole image' }).click(); // it's already the whole image
  const hips = (await page.locator('.r-joint[aria-label^="Hips"]').boundingBox())!;
  await page.mouse.click(hips.x + hips.width / 2, hips.y + hips.height / 2); // a joint pressed, not moved
  await page.waitForTimeout(1500);
  expect(await resultsKept(page)).toBe(true);
});

test('an image pasted while the viewer is open closes the viewer and searches with it', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await cells(page).first().locator('.r-open').click();
  await expect(page.locator('.r-viewer')).toBeVisible();
  await paste(page, fixture('1.jpg'), 'photo.jpg', 'image/jpeg');
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  await expect(page.locator('.r-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains('r-noscroll'))).toBe(false);
});

test('the image panel shows at once, while the pose model is still downloading', async ({ page }) => {
  await fakeWeb(page);
  // a first visit: the pose model takes a while to arrive
  await page.route(/movenet_lightning/, async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue();
  });
  await openRefs(page);
  await pickMode(page, 'Pose');
  await upload(page, 'photo.jpg', 'image/jpeg', fixture('3.jpg'));
  await expect(page.locator('.r-panel')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('#r-status')).toContainText('Reading your image');
});

test('of two quick pastes, the last one wins', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await slowDecode(page, 1500, 'slow.jpg');
  await paste(page, fixture('0.jpg'), 'slow.jpg', 'image/jpeg');
  await paste(page, fixture('stick-arms-up.png'), 'stick.png', 'image/png');
  await page.waitForTimeout(3000);
  expect(await page.locator('.r-imgwrap img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(256);
  await expect(page.locator('.r-joint')).toHaveCount(11);
});

test('a result opened while a new image decodes closes cleanly: no scroll lock, no stray history entry', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await search(page, 'lantern');
  await expect(cells(page).nth(3)).toBeVisible({ timeout: 30_000 });
  await slowDecode(page, 1200);
  await upload(page, 'photo.jpg', 'image/jpeg', fixture('2.jpg'));
  await cells(page).nth(1).locator('.r-open').click(); // an old result, while the new image is still decoding
  await expect(page.locator('.r-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.r-viewer')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.classList.contains('r-noscroll'))).toBe(false);
  expect(await page.evaluate(() => (history.state as { refsViewer?: number } | null)?.refsViewer)).toBeFalsy();
});

test('dropping a file that isn’t an image says so, without the drop overlay', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  const { overlay } = await dropFile(page, Buffer.from('some notes about a knight'), 'notes.txt', 'text/plain');
  expect(overlay).toBe(false);
  await expect(page.locator('.toast')).toContainText('isn’t an image');
  await expect(page.locator('.r-panel')).toHaveCount(0);
});

test('a tiny picture is drawn big enough to see, and a thin strip crops along its length', async ({ page }) => {
  await fakeWeb(page);
  await openRefs(page);
  await upload(page, 'tiny.png', 'image/png', await png(page, 20, 20, `x.fillStyle = '#c33'; x.fillRect(0, 0, w, h);`));
  await expect(page.locator('.r-imgwrap img')).toBeVisible();
  const tiny = (await page.locator('.r-imgwrap img').boundingBox())!;
  expect(Math.min(tiny.width, tiny.height)).toBeGreaterThanOrEqual(150);
  await upload(page, 'strip.png', 'image/png', await png(page, 4000, 120, `x.fillStyle = '#36c'; x.fillRect(0, 0, w, h);`));
  await expect(page.locator('.r-imgwrap')).toHaveClass(/r-thin-y/);
  const img = (await page.locator('.r-imgwrap img').boundingBox())!,
    wrap = (await page.locator('.r-imgwrap').boundingBox())!;
  expect(Math.abs(img.width - wrap.width) + Math.abs(img.height - wrap.height)).toBeLessThan(1); // the crop box lies over the picture
  await dragOnImage(page, [0.3, 0.5], [0.6, 0.5]);
  expect(await cropBox(page)).toEqual({ x: 0.3, y: 0, w: 0.3, h: 1 });
});

