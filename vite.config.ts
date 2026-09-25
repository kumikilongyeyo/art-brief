import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const APP_VERSION = process.env.APP_VERSION || pkg.version;
// A fingerprint of the reference-search data: its URLs carry ?v=<this>, so after a rebuild a browser can
// never mix an old vocabulary with new vector shards (the service worker caches them for 30 days).
function refsVersion(): string {
  const h = createHash('sha1');
  const root = new URL('./public/refs/', import.meta.url);
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir).sort()) {
      const u = new URL(name, dir);
      if (statSync(u).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.(json|bin)$/.test(name) && !dir.pathname.includes('/vec/')) h.update(name).update(readFileSync(u)); // shards follow vocab.json
    }
  };
  try {
    walk(root);
  } catch {
    return 'dev';
  }
  return h.digest('hex').slice(0, 10);
}
const REFS_V = refsVersion();

const ORT_VERSION = (
  JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export default defineConfig({
  base: '/art-brief/',
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __ORT_VERSION__: JSON.stringify(ORT_VERSION), __REFS_V__: JSON.stringify(REFS_V) },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: process.env.OUT_DIR || 'dist' },
  plugins: [
    // onnxruntime-web references its 14 MB wasm by URL, so the bundler copies it into the build — but the
    // workers load it once from jsDelivr (brotli, 3 MB) via the page, so the copy is dead weight.
    {
      name: 'drop-unused-ort-wasm',
      generateBundle(_opts, bundle) {
        for (const k of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(k)) delete bundle[k];
      },
    },
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'Art Brief — Fantasy Art Brief Generator',
        short_name: 'Art Brief',
        description: 'Instant D&D-flavoured art briefs for concept artists.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f7f6f2',
        theme_color: '#4c35b5',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,json,webmanifest}'],
        // Reference-search data and models are never pre-downloaded: they load (and stay cached) the first
        // time References is opened, so someone who only makes briefs downloads nothing extra.
        globIgnores: ['refs/**', 'models/**', '**/*.wasm'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/refs/') || url.pathname.includes('/models/'),
            handler: 'CacheFirst',
            options: { cacheName: 'refs-data', expiration: { maxEntries: 900, maxAgeSeconds: 60 * 60 * 24 * 30 } },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('onnxruntime-web'),
            handler: 'CacheFirst',
            options: { cacheName: 'refs-engine', expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 } },
          },
        ],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
});
