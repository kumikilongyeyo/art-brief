import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countCombinations } from '../../src/engine/count';
import { fieldEntries, generateBatch, lockedMap, rerollSlots, setLocked, type Diagnostics } from '../../src/engine/generate';
import { findArticleErrors } from '../../src/engine/grammar';
import { weightedPick } from '../../src/engine/pick';
import { rngFrom } from '../../src/engine/rng';
import { countWords } from '../../src/engine/templates';
import { isBlocked, isOnTheme } from '../../src/engine/theme';
import { rollTier, tierOdds, TIERS } from '../../src/engine/unique';
import { WEIRDNESS, type Brief, type CategoryId, type UniqueFrequency, type Weirdness } from '../../src/engine/types';
import { CATS, data, one, seeds } from './helpers';

function entriesOf(b: Brief) {
  const cat = data.categories[b.category];
  return cat.slots.map((s) => ({ slot: s, entries: fieldEntries(data, cat, s.id, b.fields[s.id].entryId) }));
}

describe('U1 determinism', () => {
  it.each(CATS)('%s: same inputs + seed give identical briefs over 1,000 runs', (c) => {
    const opts = {
      category: c,
      themeChoice: 'any' as const,
      weirdness: 'wild' as const,
      count: 4,
      base: 'K7Q2PX',
      uniqueFrequency: 'often' as const,
      createdAt: 1,
    };
    const first = JSON.stringify(generateBatch(data, opts));
    for (let i = 0; i < 1000; i++) expect(JSON.stringify(generateBatch(data, opts))).toBe(first);
  });
});

describe('U2 seed variety', () => {
  it.each(CATS)('%s: 1,000 seeds give distinct briefs and a wide spread of primary + palette pairs', (c) => {
    const primary = data.categories[c].primarySlot;
    const briefs = seeds(1000, `u2-${c}`).map((s) => one(c, s));
    const full = new Set(briefs.map((b) => b.plainText));
    const pairs = new Set(briefs.map((b) => `${b.fields[primary].entryId}|${b.fields.palette.entryId}`));
    const possible = data.tables[data.categories[c].slots.find((s) => s.id === primary)!.table!].entries.length * data.palettes.length;
    expect(full.size / 1000).toBeGreaterThanOrEqual(0.95);
    // The spec's "95% distinct primary+palette pairs" is impossible with these pool sizes (14 creature
    // types x 61 palettes = 854 pairs; even uniform draws give ~69% distinct). So: full briefs must be
    // >= 95% distinct, and the pair spread must reach 75% of what 1,000 uniform draws would give.
    const expected = possible * (1 - Math.exp(-1000 / possible));
    expect(pairs.size).toBeGreaterThanOrEqual(0.75 * expected);
  });
});

describe('U3 weighted pick', () => {
  it('10,000 draws land within ±15% of each expected share', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const weights = [1, 2, 5, 7, 10];
    const total = weights.reduce((a, b) => a + b, 0);
    const counts: Record<string, number> = {};
    const rng = rngFrom('u3');
    for (let i = 0; i < 10000; i++) {
      const x = weightedPick(items, weights, rng)!;
      counts[x] = (counts[x] ?? 0) + 1;
    }
    items.forEach((it, i) => {
      const expected = (10000 * weights[i]) / total;
      expect(Math.abs(counts[it] - expected) / expected).toBeLessThanOrEqual(0.15);
    });
  });
  it('all-zero weights return undefined (treated as empty pool)', () => {
    expect(weightedPick(['a', 'b'], [0, 0], rngFrom('z'))).toBeUndefined();
  });
});

describe('U4 hard excludes', () => {
  it.each(CATS)('%s: no excluded pair in 5,000 Wild briefs', (c) => {
    const base = data.categories[c].baseTags;
    for (const s of seeds(5000, `u4-${c}`)) {
      const b = one(c, s, { weirdness: 'wild' });
      const all = entriesOf(b);
      for (const { slot, entries } of all) {
        const otherTags = new Set([
          ...base,
          ...all.filter((x) => x.slot.id !== slot.id).flatMap((x) => x.entries.flatMap((e) => e.tags ?? [])),
        ]);
        for (const e of entries)
          for (const x of e.excludes ?? []) expect(otherTags.has(x), `${c} ${slot.id}#${e.id} excludes ${x}`).toBe(false);
      }
    }
  });
});

describe('U5 requires', () => {
  it.each(CATS)('%s: no entry with unmet requires, in every mode', (c) => {
    const cat = data.categories[c];
    for (const w of WEIRDNESS) {
      for (const s of seeds(1200, `u5-${c}-${w}`)) {
        const b = one(c, s, { weirdness: w });
        const provided = new Set(cat.baseTags);
        for (const { slot, entries } of entriesOf(b)) {
          for (const e of entries) {
            if (e.requires?.length)
              expect(
                e.requires.some((r) => provided.has(r)),
                `${c} ${slot.id}#${e.id} requires ${e.requires}`,
              ).toBe(true);
          }
          entries.forEach((e) => (e.tags ?? []).forEach((t) => provided.add(t)));
        }
      }
    }
  });
});

describe('U6 Grounded mode', () => {
  it.each(CATS)('%s: zero surreal and zero off-theme entries in 1,000 Grounded briefs (5,000 total)', (c) => {
    for (const s of seeds(1000, `u6-${c}`)) {
      const b = one(c, s, { weirdness: 'grounded' });
      const theme = data.themeById[b.theme];
      for (const { slot, entries } of entriesOf(b)) {
        for (const e of entries) {
          expect(e.surreal ?? false, `${c} ${slot.id}#${e.id} is surreal`).toBe(false);
          expect(isOnTheme(e, theme), `${c} ${slot.id}#${e.id} off-theme for ${theme.id}`).toBe(true);
          if (slot.kind !== 'material') expect(isBlocked(e, theme), `${c} ${slot.id}#${e.id} blocked in ${theme.id}`).toBe(false);
        }
      }
    }
  });
});

describe('U7 Wild mode', () => {
  it('surreal materials appear in at least 30% of material lines over 5,000 briefs', () => {
    let lines = 0;
    let surreal = 0;
    const cats: CategoryId[] = ['character', 'prop', 'building'];
    seeds(5000, 'u7').forEach((s, i) => {
      const c = cats[i % 3];
      const b = one(c, s, { weirdness: 'wild' });
      const mats = fieldEntries(data, data.categories[c], 'material', b.fields.material.entryId);
      lines++;
      if (mats.some((m) => m.surreal)) surreal++;
    });
    expect(surreal / lines).toBeGreaterThanOrEqual(0.3);
  });
});

describe('U8 locks', () => {
  it.each(CATS)('%s: a locked field survives 100 regenerations, including theme changes', (c) => {
    const first = one(c, 'LOCK00', { themeChoice: 'high-fantasy' });
    const slot = data.categories[c].primarySlot;
    const locked = setLocked(first, [slot, 'palette'], true);
    const themes = data.themes.map((t) => t.id);
    for (let i = 0; i < 100; i++) {
      const b = generateBatch(data, {
        category: c,
        themeChoice: themes[i % themes.length],
        weirdness: WEIRDNESS[i % 3],
        count: 1,
        base: seeds(1, `u8-${c}-${i}`)[0],
        uniqueFrequency: 'sometimes',
        locks: [lockedMap(locked)],
      })[0];
      expect(b.fields[slot].entryId).toBe(first.fields[slot].entryId);
      expect(b.fields.palette.entryId).toBe(first.fields.palette.entryId);
      expect(b.fields[slot].locked).toBe(true);
    }
  });
});

describe('U9 reroll scope', () => {
  it.each(CATS)('%s: reroll changes only the slot and its unlocked dependents', (c) => {
    const cat = data.categories[c];
    for (const s of seeds(60, `u9-${c}`)) {
      const b = one(c, s);
      for (const slot of cat.slots) {
        const deps = new Set([slot.id, ...(cat.dependencies[slot.id] ?? [])]);
        // Lock one dependent (if any) to prove locks beat dependencies.
        const lockDep = (cat.dependencies[slot.id] ?? [])[0];
        const start = lockDep ? setLocked(b, [lockDep], true) : b;
        const next = rerollSlots(data, start, [slot.id], 'sometimes');
        for (const other of cat.slots) {
          if (!deps.has(other.id) || other.id === lockDep)
            expect(next.fields[other.id].entryId, `${c}: reroll ${slot.id} changed ${other.id}`).toBe(start.fields[other.id].entryId);
        }
      }
    }
  });
  it.each(CATS)('%s: a direct reroll always changes the rerolled line', (c) => {
    const cat = data.categories[c];
    for (const s of seeds(40, `u9b-${c}`)) {
      const b = one(c, s);
      for (const slot of cat.slots) {
        if (slot.kind === 'name' || (slot.kind === 'unique' && b.fields.unique.entryId === 'none')) continue;
        const next = rerollSlots(data, b, [slot.id], 'often');
        if (slot.kind === 'unique' && next.fields.unique.entryId === 'none') continue;
        expect(next.fields[slot.id].entryId, `${c} ${slot.id}`).not.toBe(b.fields[slot.id].entryId);
      }
    }
  });
  it('rerolling a slot repeatedly produces new values', () => {
    let b = one('creature', 'REROLL');
    const seen = new Set([b.fields.habitat.entryId]);
    for (let i = 0; i < 20; i++) {
      b = rerollSlots(data, b, ['habitat'], 'sometimes');
      seen.add(b.fields.habitat.entryId);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('U10 batch diversity', () => {
  it.each(CATS)('%s: primary slot unique within a 4-card batch in 1,000 of 1,000 batches', (c) => {
    const primary = data.categories[c].primarySlot;
    const themes = ['any', ...data.themes.map((t) => t.id)];
    seeds(1000, `u10-${c}`).forEach((base, i) => {
      const briefs = generateBatch(data, {
        category: c,
        themeChoice: themes[i % themes.length],
        weirdness: WEIRDNESS[i % 3],
        count: 4,
        base,
        uniqueFrequency: 'sometimes',
      });
      expect(new Set(briefs.map((b) => b.fields[primary].entryId)).size).toBe(4);
      expect(new Set(briefs.map((b) => b.fields.palette.entryId)).size).toBe(4);
    });
  });
});

describe('U11 unique-trait rates', () => {
  it('base odds match the spec', () => {
    expect(tierOdds('sometimes', 'grounded')).toEqual({ none: 0.45, minor: 0.35, notable: 0.15, legendary: 0.05 });
    const often = tierOdds('often', 'grounded');
    expect(often.none).toBeCloseTo(0.225);
    expect(often.minor / often.notable).toBeCloseTo(0.35 / 0.15);
    expect(tierOdds('never', 'wild').none).toBe(1);
  });
  const freqs: UniqueFrequency[] = ['never', 'sometimes', 'often'];
  for (const f of freqs) {
    for (const w of WEIRDNESS) {
      it(`${f} / ${w}: tier frequencies within ±3 points over 10,000 rolls`, () => {
        const odds = tierOdds(f, w);
        const counts: Record<string, number> = { none: 0, minor: 0, notable: 0, legendary: 0 };
        const rng = rngFrom(`u11-${f}-${w}`);
        for (let i = 0; i < 10000; i++) counts[rollTier(f, w, rng)]++;
        for (const t of TIERS) expect(Math.abs(counts[t] / 10000 - odds[t])).toBeLessThanOrEqual(0.03);
      });
    }
  }
  it('generated briefs follow the same rates (Sometimes, Grounded)', () => {
    let none = 0;
    const n = 3000;
    for (const s of seeds(n, 'u11-gen')) if (one('creature', s, { weirdness: 'grounded' }).fields.unique.entryId === 'none') none++;
    expect(Math.abs(none / n - 0.45)).toBeLessThanOrEqual(0.03);
  });
});

describe('U12 word budget', () => {
  it.each(CATS)('%s: no brief over 80 words in 5,000; title and palette always present', (c) => {
    seeds(5000, `u12-${c}`).forEach((s, i) => {
      const b = one(c, s, { weirdness: WEIRDNESS[i % 3], uniqueFrequency: 'often' });
      expect(countWords(b.title, b.lines), b.plainText).toBeLessThanOrEqual(80);
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.lines.some((l) => l.slot === 'palette')).toBe(true);
      if (b.fields.unique.entryId !== 'none') expect(b.lines.some((l) => l.slot === 'unique')).toBe(true);
    });
  });
});

describe('U13–U15 exhaustive sweep', () => {
  const failures: string[] = [];
  const grammar: string[] = [];
  const diag: Diagnostics = { maxDepth: 0, events: [] };
  let total = 0;
  for (const c of CATS) {
    for (const t of data.themes) {
      for (const w of WEIRDNESS as Weirdness[]) {
        for (const s of seeds(50, `sweep-${c}-${t.id}-${w}`)) {
          // 50 seeds x 4 variations = 200 briefs per category x theme x weirdness
          let briefs: Brief[] = [];
          try {
            briefs = generateBatch(
              data,
              { category: c, themeChoice: t.id, weirdness: w, count: 4, base: s, uniqueFrequency: 'often' },
              diag,
            );
          } catch (e) {
            failures.push(`${c}/${t.id}/${w}/${s}: threw ${(e as Error).message}`);
          }
          for (const b of briefs) {
            total++;
            const txt = b.plainText;
            if (/undefined|null|NaN|[{}]/.test(txt)) failures.push(`${c}/${t.id}/${w}: bad token in "${txt}"`);
            if (/ {2,}/.test(txt)) failures.push(`${c}/${t.id}/${w}: double space in "${txt}"`);
            if (b.lines.some((l) => !l.text.trim()) || !b.title.trim()) failures.push(`${c}/${t.id}/${w}: empty line in "${txt}"`);
            if (/ — $| of $|, $/m.test(txt)) failures.push(`${c}/${t.id}/${w}: dangling text in "${txt}"`);
            for (const g of findArticleErrors(txt)) grammar.push(`${c}: "${g}" in ${b.title}`);
          }
        }
      }
    }
  }
  it('U13: every category x theme x weirdness generates 200 clean briefs', () => {
    expect(total).toBe(5 * 13 * 3 * 200);
    expect(failures.slice(0, 10)).toEqual([]);
  });
  it('U14: shipped data never reaches fallback step 3', () => {
    const deep = diag.events.filter((e) => e.depth >= 3);
    expect(deep.slice(0, 10)).toEqual([]);
    expect(diag.maxDepth).toBeLessThan(3);
  });
  it('U15: no a/an errors in rendered text', () => {
    expect(grammar.slice(0, 10)).toEqual([]);
  });
});

describe('scene events', () => {
  it('actors never echo a word already in the event', () => {
    const words = (t: string) => (t.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
    const events = data.tables['scene.event'].entries;
    const actors = data.tables['scene.actors'].entries;
    for (const s of seeds(2000, 'echo')) {
      const b = one('scene', s, { weirdness: WEIRDNESS[s.charCodeAt(0) % 3] });
      const [evId, ...actorIds] = b.fields.event.entryId.split('~');
      const ev = new Set(words(events.find((e) => e.id === evId)!.text));
      for (const id of actorIds) {
        const a = actors.find((x) => x.id === id)!;
        expect(
          words(a.text).some((w) => ev.has(w)),
          `${a.text} echoes ${evId}`,
        ).toBe(false);
      }
    }
  });
});

describe('U19 combination count', () => {
  it.each(CATS)('%s: at least 100,000 combinations', (c) => {
    expect(countCombinations(data, c)).toBeGreaterThanOrEqual(100000);
  });
});

describe('U20 no Math.random in the engine', () => {
  it('src/engine never calls Math.random', () => {
    const dir = join(__dirname, '../../src/engine');
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/Math\.random/);
  });
});

describe('performance', () => {
  it('generates 4 briefs in under 20 ms', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++)
      generateBatch(data, {
        category: 'character',
        themeChoice: 'any',
        weirdness: 'wild',
        count: 4,
        base: seeds(1, `p${i}`)[0],
        uniqueFrequency: 'often',
      });
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});
