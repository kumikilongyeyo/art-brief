import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { choose, core, defaultStyle, fit, ing, lightWord, partsFor, placeTries, STYLES, variants, type Part } from '../../src/refs/brief-refs';
import type { Hit } from '../../src/refs/engine';
import type { Cand } from '../../src/refs/types';
import { vocabFrom, type VocabFile } from '../../src/refs/vocab';
import { CATS, data, one, seeds } from './helpers';

const v = vocabFrom(JSON.parse(readFileSync(new URL('../../public/refs/vocab.json', import.meta.url), 'utf8')) as VocabFile);

describe('brief reference words', () => {
  it('keeps the heart of a descriptive line', () => {
    expect(core('robed scholar with a fat spellbook and staff')).toBe('robed scholar');
    expect(core('crouched on a gargoyle, scanning the street below')).toBe('crouched on gargoyle');
    expect(core('monastic wrap {m} tied at the hip', 3)).toBe('monastic wrap');
    expect(core('jungle canopy strung with rope bridges')).toBe('jungle canopy');
    expect(core('midnight under a blood-red moon', 3)).toBe('midnight blood-red moon');
  });

  it('splits places at their prepositions, two-word phrases first', () => {
    expect(placeTries('black-smoker vents in an abyssal trench').slice(0, 2)).toEqual(['black-smoker vents', 'abyssal trench']);
    expect(placeTries('moss-hung old-growth forest')).toContain('old-growth forest');
    expect(placeTries('jungle canopy strung with rope bridges')[0]).toBe('jungle canopy');
  });

  it('never asks with one bare word', () => {
    expect(variants('gate statues')).not.toContain('statues');
    expect(variants('gate statues')).toContain('fantasy statues');
  });

  it('turns pose words into how poses are titled', () => {
    expect(ing('crouched')).toBe('crouching');
    expect(ing('leaps')).toBe('leaping');
    expect(ing('kneeling')).toBe('kneeling');
    expect(ing('raised')).toBe('raised'); // not a pose word: left alone
  });

  it('reads the particular light first', () => {
    expect(lightWord('dusk thunderstorm, lightning every few breaths')).toBe('lightning storm');
    expect(lightWord('rim light from behind, the front half in shadow')).toBe('rim light');
  });

  it('builds 5–10 pictures of short searches for every category, subject first', () => {
    for (const cat of CATS)
      for (const seed of seeds(12, `refs-${cat}`)) {
        const parts = partsFor(data, one(cat, seed), v);
        const total = parts.reduce((n, p) => n + p.n, 0);
        expect(parts[0].id, cat).toBe('subject');
        expect(total, `${cat} ${seed}`).toBeGreaterThanOrEqual(5);
        expect(total, `${cat} ${seed}`).toBeLessThanOrEqual(10);
        for (const p of parts) {
          expect(p.tries.length, `${cat} ${p.id}`).toBeGreaterThan(0);
          for (const q of p.tries) {
            expect(q.split(' ').length, `${cat} ${p.id}: ${q}`).toBeLessThanOrEqual(6);
            expect(q, `${cat} ${p.id}`).not.toMatch(/\{|\}|\s{2}|^\s|\s$/);
          }
        }
      }
  });

  it('adds a Render section from one source only, in the style the job suggests or the one chosen', () => {
    for (const cat of CATS) {
      const b = one(cat, `render-${cat}`);
      const parts = partsFor(data, b, v);
      const render = parts.find((p) => p.id === 'render')!;
      const want = STYLES.find((s) => s.id === defaultStyle(b))!;
      expect(render.only, cat).toEqual([want.src]);
      // another style changes the render part's source and nothing else
      const other = partsFor(data, b, v, 'lorcana');
      expect(other.find((p) => p.id === 'render')!.only).toEqual(['lorcana']);
      expect(other.filter((p) => p.id !== 'render')).toEqual(parts.filter((p) => p.id !== 'render'));
    }
    expect(defaultStyle({ ...one('character', 'r1'), art: { ...one('character', 'r1').art!, purpose: 'TCG card art' } })).toBe('mtg');
    expect(defaultStyle({ ...one('character', 'r1'), art: { ...one('character', 'r1').art!, purpose: 'Cinematic key frame' } })).toBe('lol');
  });

  it('asks for a character by kind and class, and its subclass', () => {
    const b = one('character', 'refs-char');
    const [subject, cls] = partsFor(data, b, v);
    const label = (slot: string) => {
      const def = data.categories.character.slots.find((s) => s.id === slot)!;
      return data.tables[def.table!].entries.find((e) => e.id === b.fields[slot].entryId)!.label!.toLowerCase();
    };
    expect(subject.tries[0]).toBe(`${label('species')} ${label('class')}`); // "half-orc fighter"
    expect(cls.id).toBe('class');
    expect(cls.tries[0]).toContain(label('class'));
  });
});

const vec = (i: number) => {
  const a = new Float32Array(8);
  a[i % 8] = 1;
  return a;
};
const hit = (key: string, src: Cand['src'], title: string, sim: number, pos = 0, v = vec(key.length)): Hit => ({
  c: { key, src, title, thumb: `https://x/${key}.jpg`, full: `https://x/${key}.jpg`, page: `https://x/${key}`, tags: [], pos } as Cand,
  prelim: 0,
  sim,
  vec: v,
  state: 'ranked',
});
const part: Part = { id: 'subject', label: 'Subject', tries: ['half-elf rogue'], query: 'half-elf rogue', mode: 'pose', n: 2, kind: 'figure' };

describe('choosing a part’s pictures', () => {
  it('trusts a title that names the thing over a slightly closer look', () => {
    const named = hit('a', 'artstation', 'Half-Elf Rogue', 0.26, 5);
    const lookalike = hit('bb', 'lol', 'Arcade Caitlyn', 0.29, 0);
    expect(fit(named, part, 0.29)).toBeGreaterThan(fit(lookalike, part, 0.29));
  });

  it('skips software tutorials, asset packs and reference compilations', () => {
    const best = 0.3;
    expect(fit(hit('a', 'artstation', 'Half-Elf Rogue', 0.3), part, best)).toBeGreaterThan(0);
    expect(fit(hit('b', 'artstation', 'Half-Elf Rogue — Substance tutorial', 0.3), part, best)).toBeLessThan(-0.9);
    expect(fit(hit('c', 'artstation', '490+ Fantasy Rogue Outfit References', 0.3), part, best)).toBeLessThan(-0.9);
  });

  it('never takes a near copy of a picture already on the board, or three from one game', () => {
    const vecs = new Map<string, Float32Array>();
    const same = vec(1);
    const onBoard = { key: 'x', src: 'hearthstone', title: '', thumb: '', full: '', page: '', part: 'look', label: 'Look', q: '' };
    vecs.set('x', same);
    const hits = [
      hit('copy', 'artstation', 'Half-Elf Rogue', 0.3, 0, same),
      hit('h1', 'hearthstone', 'Rogue', 0.3, 0, vec(3)),
      hit('h2', 'hearthstone', 'Rogue', 0.3, 0, vec(4)),
      hit('ok', 'artstation', 'Half Elf Rogue', 0.3, 1, vec(5)),
    ];
    const r = choose(part, hits, [onBoard], vecs);
    expect(r.picks.map((p) => p.key)).not.toContain('copy');
    expect(r.picks.filter((p) => p.src === 'hearthstone').length).toBeLessThanOrEqual(1);
    expect(r.picks.length).toBe(2);
  });
});
