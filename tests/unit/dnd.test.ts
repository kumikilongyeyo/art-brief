import { afterEach, describe, expect, it } from 'vitest';
import { rollFor } from '../../src/engine/dice';
import { generateBatch } from '../../src/engine/generate';
import { alignmentFromTraits } from '../../src/engine/stat';
import { DEFAULT_INSTRUCTION, loadSettings, resetStorageProbe } from '../../src/storage';
import { WEIRDNESS, type Brief } from '../../src/engine/types';
import { CATS, data, one, seeds } from './helpers';

const tierOf = (b: Brief) => {
  const id = b.fields.unique.entryId;
  if (id === 'none') return 'none';
  return [...data.tables['shared.unique'].entries, ...data.tables[`${b.category}.unique`].entries].find((e) => e.id === id)!.tier!;
};

describe('D&D stat tag', () => {
  const FORMAT: Record<string, RegExp> = {
    prop: /^(Weapon|Armor|Staff|Wand|Rod|Ring|Wondrous item), (common|uncommon|rare|very rare|legendary|artifact)( \(requires attunement( by an? [a-z]+)?\))?$/,
    creature: /^(Tiny|Small|Medium|Large|Huge|Gargantuan) [a-z]+, [a-z ]+ · CR [0-9/]+( · legendary actions)?$/,
    character: /^Level ([1-9]|1[0-9]|20) · (true neutral|(lawful|neutral|chaotic) (good|neutral|evil)|lawful|chaotic|good|evil)$/,
    building: /^Adventure site · Tier [1-4] \(levels [0-9–]+\) · danger: (low|moderate|high|deadly)$/,
    scene: /^Encounter · (Easy|Medium|Hard|Deadly) · levels [0-9–]+$/,
  };
  it.each(CATS)('%s: every brief has a well-formed stat line, also in the copied text', (c) => {
    for (const s of seeds(600, `stat-${c}`)) {
      const b = one(c, s, { weirdness: WEIRDNESS[s.charCodeAt(1) % 3], uniqueFrequency: 'often' });
      expect(b.stat, `${c}: ${b.stat}`).toMatch(FORMAT[c]);
      expect(b.plainText.split('\n')[1]).toBe(`D&D: ${b.stat}`);
    }
  });
  it('prop rarity follows the unique trait', () => {
    for (const s of seeds(1500, 'rarity')) {
      const b = one('prop', s, { uniqueFrequency: 'often' });
      const t = tierOf(b);
      if (t === 'legendary') expect(b.stat).toMatch(/very rare|legendary|artifact/);
      if (t === 'none') expect(b.stat).toMatch(/common|uncommon|rare/);
      if (t === 'none') expect(b.stat).not.toMatch(/very rare|legendary|artifact/);
    }
  });
  it('creature size follows the Scale line and CR fits the size', () => {
    const maxCr: Record<string, number> = { Tiny: 2, Small: 3, Medium: 8, Large: 10, Huge: 17, Gargantuan: 24 };
    for (const s of seeds(1500, 'cr')) {
      const b = one('creature', s);
      const [, size, cr] = b.stat!.match(/^(\w+) .* CR ([0-9/]+)/)!;
      const n = cr.includes('/') ? 0.5 : Number(cr);
      expect(n, b.stat).toBeLessThanOrEqual(maxCr[size]);
      if (/mouse|cat-sized/.test(b.fields.scale.text)) expect(size).toBe('Tiny');
      if (/whale|cathedral|galley/.test(b.fields.scale.text)) expect(size).toBe('Gargantuan');
    }
  });
  it('character level follows the unique trait', () => {
    for (const s of seeds(1500, 'lvl')) {
      const b = one('character', s, { uniqueFrequency: 'often' });
      const level = Number(b.stat!.match(/Level (\d+)/)![1]);
      if (tierOf(b) === 'legendary') expect(level).toBeGreaterThanOrEqual(11);
      if (tierOf(b) === 'none') expect(level).toBeLessThanOrEqual(8);
    }
  });
  it('alignment reads the traits', () => {
    expect(alignmentFromTraits('quietly cruel, formal')).toBe('lawful evil');
    expect(alignmentFromTraits('prankish, gentle')).toBe('chaotic good');
    expect(alignmentFromTraits('curious, blunt')).toBe('true neutral');
  });
});

describe('coherence', () => {
  it('scene events that need a person never get an owlbear, beholder, cube, mimic or wyrmling', () => {
    const events = data.tables['scene.event'].entries;
    const actors = data.tables['scene.actors'].entries;
    for (const s of seeds(2000, 'roles')) {
      const b = one('scene', s);
      const [evId, aId, bId] = b.fields.event.entryId.split('~');
      const ev = events.find((e) => e.id === evId)!;
      for (const [who, id] of [
        ['a', aId],
        ['b', bId],
      ] as const) {
        if (!id || !ev.people?.includes(who)) continue;
        expect(actors.find((x) => x.id === id)!.tags, `${ev.text} got ${id}`).toContain('humanoid');
      }
    }
  });

  it('palettes lean warm for fire and cool for frost', () => {
    const share = (theme: string, tag: string) => {
      let n = 0;
      for (const s of seeds(600, `pal-${theme}`)) {
        const b = one('prop', s, { themeChoice: theme, weirdness: 'grounded' });
        if (data.palettes.find((p) => p.id === b.fields.palette.entryId)!.tags?.includes(tag)) n++;
      }
      return n / 600;
    };
    expect(share('elemental-fire', 'warm')).toBeGreaterThan(share('frost', 'warm'));
    expect(share('frost', 'cool')).toBeGreaterThan(share('elemental-fire', 'cool'));
  });

  it('object-only places never turn up in character or creature stories', () => {
    const objectOnly = [...data.tables['shared.lore-place'].entries, ...data.tables['shared.lore-venue'].entries]
      .filter((e) => e.excludes?.includes('animate'))
      .map((e) => e.text);
    let composed = 0;
    for (const c of ['character', 'creature'] as const) {
      for (const s of seeds(800, `obj-${c}`)) {
        const text = generateBatch(data, {
          category: c,
          themeChoice: 'any',
          weirdness: 'mixed',
          count: 1,
          base: s,
          uniqueFrequency: 'sometimes',
          lore: true,
        })[0].lore!.text;
        for (const p of objectOnly) expect(text, `${c}: "${p}"`).not.toContain(p);
        if (/ in (Waterdeep|Baldur's Gate|Neverwinter|Sigil|Luskan|Menzoberranzan|Candlekeep)/.test(text)) composed++;
      }
    }
    expect(composed).toBeGreaterThan(0); // composed "{venue} in {city}" places are in use
  });
});

describe('dice', () => {
  it('each line shows a d100 roll inside its entry’s slice', () => {
    const cat = data.categories.creature;
    const habitats = data.tables['creature.habitat'].entries;
    const total = habitats.reduce((n, e) => n + (e.weight ?? 5), 0);
    for (const s of seeds(300, 'dice')) {
      const b = one('creature', s);
      const r = rollFor(data, cat, 'habitat', b.fields.habitat.entryId, b.seed)!;
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(100);
      expect(rollFor(data, cat, 'habitat', b.fields.habitat.entryId, b.seed)).toBe(r);
      let acc = 0;
      for (const e of habitats) {
        if (e.id === b.fields.habitat.entryId) {
          expect(r).toBeGreaterThanOrEqual(Math.floor((acc / total) * 100));
          expect(r).toBeLessThanOrEqual(Math.ceil(((acc + (e.weight ?? 5)) / total) * 100) + 1);
        }
        acc += e.weight ?? 5;
      }
    }
    expect(rollFor(data, cat, 'name', 'Ashmaw Wader', 'X')).toBeNull();
  });
});

describe('prompt upgrade', () => {
  const g = globalThis as unknown as { localStorage?: unknown };
  afterEach(() => {
    delete g.localStorage;
    resetStorageProbe();
  });
  it('an untouched old default art prompt is upgraded; a custom one is kept', () => {
    const old =
      'You are an art director writing for a fantasy concept artist.\nRewrite the art brief below into one vivid paragraph of 60–90 words.\nKeep every element listed. Do not add new characters, objects or colours.\nImpossible or surreal materials are intentional: describe how they\ncould look, do not correct or explain them away.\nThen give 3 thumbnail composition ideas, one short line each.\n\nBRIEF:\n{{brief}}';
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
    resetStorageProbe();
    store.set('ab:settings', JSON.stringify({ schemaVersion: 1, value: { instruction: old } }));
    expect(loadSettings().instruction).toBe(DEFAULT_INSTRUCTION);
    expect(DEFAULT_INSTRUCTION).toContain('Silhouette');
    store.set('ab:settings', JSON.stringify({ schemaVersion: 1, value: { instruction: 'My own prompt {{brief}}' } }));
    expect(loadSettings().instruction).toBe('My own prompt {{brief}}');
  });
});
