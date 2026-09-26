import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Plan } from '../../src/refs/types';

// The Flesh and Blood and Pokémon catalogs as shipped: their rows, their index, and the pictures the
// sources build from them (the art window cropped out of the card, never the whole card).
const file = (p: string) => new URL(`../../public/refs/${p}`, import.meta.url);
type Row = [string, string, string, string?, string?];
const rows = (id: string) => JSON.parse(readFileSync(file(`catalogs/${id}.json`), 'utf8')) as Row[];

vi.mock('../../src/refs/net', async (orig) => ({
  ...(await orig<typeof import('../../src/refs/net')>()),
  catalog: async (id: string) => rows(id),
}));
// no index here: the sources fall back to matching the cards' words
vi.mock('../../src/refs/idx', () => ({
  nearest: async () => {
    throw new Error('no index');
  },
  byPose: async () => [],
  vectorOf: async () => null,
  figureRows: async () => () => false,
}));
const { SOURCE_BY_ID } = await import('../../src/refs/sources');

const plan = (words: string[], mode: Plan['mode']): Plan => ({ text: words.join(' '), words, keys: [], nouns: [], booru: [], scry: [], mode, adult: false });
const run = (id: 'fab' | 'pokemon', words: string[], mode: Plan['mode']) =>
  SOURCE_BY_ID[id].search(plan(words, mode), 0, new AbortController().signal, { q: null, memo: new Map() });

describe.each([
  ['fab', /^[A-Z0-9][A-Za-z0-9_-]*$/, 2500, 4500],
  ['pokemon', /^[a-z0-9]+-[A-Za-z0-9]+$/, 2500, 4000],
] as const)('%s catalog', (id, idPattern, min, max) => {
  const r = rows(id);
  it('rows are well formed, one per artwork', () => {
    expect(r.length).toBeGreaterThanOrEqual(min);
    expect(r.length).toBeLessThanOrEqual(max);
    for (const x of r) {
      expect(x.length, JSON.stringify(x)).toBeGreaterThanOrEqual(3);
      expect(x[0]).toMatch(idPattern);
      expect(x[1].trim().length).toBeGreaterThan(0);
      expect(x[2]).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
    }
    expect(new Set(r.map((x) => x[0])).size).toBe(r.length);
    expect(readFileSync(file(`catalogs/${id}.json`)).length).toBeLessThan(700_000);
  });
  it.runIf(existsSync(file(`idx/${id}/meta.json`)))('the index covers every row', () => {
    const meta = JSON.parse(readFileSync(file(`idx/${id}/meta.json`), 'utf8')) as { n: number; missing: number };
    expect(meta.n).toBe(r.length);
    expect(meta.missing).toBeLessThan(r.length * 0.02);
  });
});

describe('card-art sources', () => {
  it('Flesh and Blood: cropped art through wsrv.nl, a FaBrary page per card', async () => {
    const { items } = await run('fab', ['ninja'], 'concept');
    expect(items.length).toBeGreaterThan(5);
    for (const c of items) {
      expect(c.thumb).toMatch(/^https:\/\/wsrv\.nl\/\?url=legendstory-production-s3-public\.s3\.amazonaws\.com.*&cx=.*&precrop/);
      expect(c.full).toContain('&we'); // the viewer's copy is never blown up past the scan
      expect(c.page).toMatch(/^https:\/\/fabrary\.net\/cards\/[a-z0-9-]+$/);
      expect(c.tags).toContain('ninja');
    }
  });
  it('Pokémon: full-art cards crop differently from framed ones', async () => {
    const { items } = await run('pokemon', ['charizard'], 'creature');
    expect(items.length).toBeGreaterThan(3);
    const full = rows('pokemon').filter((x) => x[4] === 'f').map((x) => x[0]);
    for (const c of items) {
      expect(c.thumb).toMatch(/^https:\/\/wsrv\.nl\/\?url=images\.scrydex\.com.*precrop/);
      expect(c.page).toMatch(/^https:\/\/scrydex\.com\/pokemon\/cards\/[a-z0-9-]+\/[a-z0-9]+-[A-Za-z0-9]+$/);
      expect(c.thumb.includes('ch=42%25')).toBe(full.includes(c.key.slice('pokemon:'.length)));
    }
  });
  it('Pokémon is only asked for creatures (the engine skips sources under 0.3)', () => {
    const t = SOURCE_BY_ID.pokemon.trust;
    expect(t.creature).toBeGreaterThanOrEqual(0.3);
    for (const m of ['pose', 'concept', 'place', 'prop'] as const) expect(t[m]).toBeLessThan(0.3);
  });
});
