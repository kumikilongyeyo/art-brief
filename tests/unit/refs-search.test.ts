import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cand, Page, SourceId } from '../../src/refs/types';

// The search engine with its outside world faked: two web sources that answer from a per-test script,
// a "model" that reads each thumbnail's vector from a table, and a word list that knows one query.
const D = 128;
const fake = vi.hoisted(() => ({
  pages: new Map<string, (page: number) => Page>(),
  vecs: new Map<string, Float32Array>(),
  imageFails: false,
}));

vi.mock('../../src/refs/vocab', () => {
  const q = new Float32Array(128);
  q[0] = 1;
  return {
    DIM: 128,
    loadVocab: async () => ({}),
    makePlan: (_v: unknown, text: string, mode: string) => ({
      text,
      words: text.split(' ').filter(Boolean),
      keys: [],
      nouns: [],
      booru: [],
      scry: [],
      mode: mode === 'auto' ? 'concept' : mode,
      adult: false,
    }),
    queryVector: async () => q,
    gateScorer: async () => () => -1,
    imageWords: async () => [],
    segment: () => [],
    normalize: (a: Float32Array) => {
      const n = Math.hypot(...a) || 1;
      return a.map((x) => x / n);
    },
  };
});
vi.mock('../../src/refs/vision', () => ({
  warmVision: async () => undefined,
  visionFailed: () => false,
  visionState: () => ({ phase: 'ready', loaded: 0, total: 0 }),
  embedBitmap: async () => {
    if (fake.imageFails) throw new TypeError('Failed to fetch'); // the model can't download
    return { vecs: [new Float32Array(128)] };
  },
  embedUrl: async (url: string) => {
    const v = fake.vecs.get(url);
    if (!v) throw new Error('404');
    return { vecs: [v] };
  },
}));
vi.mock('../../src/refs/sources', () => {
  const src = (id: string) => ({
    id,
    label: id,
    trust: { pose: 0.9, concept: 0.9, place: 0.9, prop: 0.9, creature: 0.9 },
    corsThumb: true,
    search: async (_plan: unknown, page: number) => fake.pages.get(id)?.(page) ?? { items: [], more: false },
  });
  const SOURCES = [src('openverse'), src('commons')];
  return { SOURCES, SOURCE_BY_ID: Object.fromEntries(SOURCES.map((s) => [s.id, s])), feedSources: () => SOURCES };
});

const { Search } = await import('../../src/refs/engine');
const { SOURCES } = await import('../../src/refs/sources');

/** A picture matching the query by `sim`, in its own direction `i` (so no two are reprints of each other). */
function pic(i: number, sim: number, base?: Float32Array): Float32Array {
  const v = base ? base.map((x) => x * sim) : new Float32Array(D);
  if (!base) v[0] = sim;
  v[i] = Math.sqrt(1 - sim * sim);
  return v;
}
function cand(src: SourceId, id: string, vec: Float32Array, pos = 0): Cand {
  const thumb = `t:${src}:${id}`;
  fake.vecs.set(thumb, vec);
  return { key: `${src}:${id}`, src, title: id, thumb, full: thumb, page: '', tags: [], pos };
}
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

beforeEach(() => {
  fake.pages.clear();
  fake.vecs.clear();
  fake.imageFails = false;
  for (const s of SOURCES) s.trust.concept = 0.9;
});

describe('search lifecycle', () => {
  it('keeps asking for pages when every unseen result is below the relevance floor', async () => {
    const good = Array.from({ length: 4 }, (_, i) => cand('openverse', `good${i}`, pic(1 + i, 0.9), i));
    const poor = Array.from({ length: 45 }, (_, i) => cand('openverse', `poor${i}`, pic(11 + i, 0.3), 10 + i));
    const later = Array.from({ length: 12 }, (_, i) => cand('openverse', `later${i}`, pic(60 + i, 0.88), i));
    fake.pages.set('openverse', (p) => (p === 0 ? { items: [...good, ...poor], more: true } : { items: later, more: false }));
    const s = new Search({ text: 'castle', mode: 'concept', adult: false });
    const shown = (await s.next()).map((h) => h.c.title);
    expect(good.every((c) => shown.includes(c.title))).toBe(true);
    // 45 ranked results that never pass mustn't stop the next page from being asked for
    for (;;) {
      const batch = await within(s.next(), 8000);
      if (batch === 'timeout') throw new Error(`stalled after ${shown.length} results`);
      if (!batch.length) break;
      shown.push(...batch.map((h) => h.c.title));
    }
    expect(shown.filter((t) => t.startsWith('later'))).toHaveLength(later.length);
    expect(shown.some((t) => t.startsWith('poor'))).toBe(false);
    expect(s.status().exhausted).toBe(true);
  });

  it('a search none of the enabled sources cover ends at once instead of waiting forever', async () => {
    for (const s of SOURCES) s.trust.concept = 0.1;
    const s = new Search({ text: 'castle', mode: 'concept', adult: false });
    expect(await within(s.next(), 3000)).toEqual([]);
    expect(s.status()).toMatchObject({ exhausted: true, sourcesAsked: 0, failed: false });
  });

  it('an image search whose model can’t download ends (and says so) instead of throwing or hanging', async () => {
    fake.imageFails = true;
    const s = new Search({ text: '', mode: 'auto', adult: false, image: {} as ImageBitmap });
    expect(await within(s.next(), 3000)).toEqual([]);
    expect(s.status()).toMatchObject({ exhausted: true, failed: true });
  });
});

describe('Similar', () => {
  it('is six different pictures, and leaves out the one you turned down', async () => {
    const me = pic(1, 0.9);
    const near = (i: number, t: number) => pic(i, t, me); // looks like `me` by t
    const a = near(10, 0.9);
    const items = [
      cand('openverse', 'me', me),
      cand('openverse', 'A', a),
      cand('commons', 'A reprint', a.slice()),
      cand('openverse', 'B', near(11, 0.88)),
      cand('openverse', 'C', near(12, 0.87)),
      cand('openverse', 'D', near(13, 0.84)),
      cand('openverse', 'E', near(14, 0.82)),
      cand('openverse', 'F', near(15, 0.8)),
      cand('openverse', 'G', near(16, 0.78)),
    ];
    fake.pages.set('openverse', () => ({ items: items.filter((c) => c.src === 'openverse'), more: false }));
    fake.pages.set('commons', () => ({ items: items.filter((c) => c.src === 'commons'), more: false }));
    const s = new Search({ text: 'castle', mode: 'concept', adult: false });
    await vi.waitFor(() => expect(s.status().ranked).toBe(items.length), { timeout: 5000 });
    s.vote('openverse:C', 'down');
    const sim = s.similar('openverse:me', 6);
    // one of the two identical A's, and no C
    expect(sim.map((h) => h.c.title.replace(' reprint', ''))).toEqual(['A', 'B', 'D', 'E', 'F', 'G']);
    for (const x of sim) for (const y of sim) if (x !== y) expect(dot(x.vec!, y.vec!)).toBeLessThan(0.955);
    s.abort();
  });
});
