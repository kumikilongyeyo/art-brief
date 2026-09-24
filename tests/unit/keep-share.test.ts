import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatText } from '../../src/chat';
import { generateBatch, generateVariation, lockedMap, rerollSlots, setLocked, type Pin } from '../../src/engine/generate';
import { chooseFreshBatch } from '../../src/engine/recent';
import { decodeShare, encodeShare } from '../../src/share';
import {
  addToHistory,
  DEFAULT_SETTINGS,
  exportFileName,
  exportSaved,
  HISTORY_LIMIT,
  importSaved,
  loadHistory,
  loadSaved,
  loadSettings,
  resetStorageProbe,
  saveHistory,
  saveSaved,
  saveSettings,
  storageAvailable,
} from '../../src/storage';
import type { Brief } from '../../src/engine/types';
import { CATS, data, one, seeds } from './helpers';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const g = globalThis as unknown as { localStorage?: unknown };

describe('U16 share round-trip', () => {
  it.each(CATS)('%s: batch encode → decode → generate reproduces the batch', (c) => {
    for (const base of seeds(40, `u16-${c}`)) {
      const opts = {
        category: c,
        themeChoice: 'any' as const,
        weirdness: 'wild' as const,
        count: 3,
        base,
        uniqueFrequency: 'sometimes' as const,
      };
      const a = generateBatch(data, opts);
      const s = decodeShare(encodeShare({ ...opts, version: data.version }), data)!;
      const b = generateBatch(data, {
        category: s.category,
        themeChoice: s.themeChoice,
        weirdness: s.weirdness,
        count: s.count,
        base: s.base,
        uniqueFrequency: s.uniqueFrequency,
      });
      expect(b.map((x) => x.plainText)).toEqual(a.map((x) => x.plainText));
    }
  });

  it.each(CATS)('%s: a card link (after rerolls and locks) rebuilds the exact card', (c) => {
    for (const base of seeds(30, `u16c-${c}`)) {
      const batch = generateBatch(data, { category: c, themeChoice: 'any', weirdness: 'mixed', count: 4, base, uniqueFrequency: 'often' });
      const cat = data.categories[c];
      let b = batch[2];
      b = rerollSlots(data, b, [cat.slots[3].id], 'often');
      b = setLocked(b, ['palette'], true);
      const fields = Object.fromEntries(Object.entries(b.fields).map(([k, f]) => [k, f.entryId]));
      const hash = encodeShare({
        category: c,
        themeChoice: b.theme,
        weirdness: b.weirdness,
        count: 1,
        base: b.base,
        version: data.version,
        uniqueFrequency: 'often',
        index: b.index,
        seed: b.seed,
        fields,
        locked: lockedMap(b),
      });
      const s = decodeShare(hash, data)!;
      const pins: Record<string, Pin> = {};
      for (const [slot, entryId] of Object.entries(s.fields!)) pins[slot] = { entryId, locked: s.locked?.[slot] === entryId };
      const r = generateVariation(data, {
        category: c,
        theme: s.themeChoice as string,
        themeChoice: s.themeChoice,
        weirdness: s.weirdness,
        base: s.base,
        index: s.index!,
        seed: s.seed!,
        uniqueFrequency: s.uniqueFrequency,
        pins,
      });
      expect(r.plainText).toBe(b.plainText);
      expect(r.fields.palette.locked).toBe(true);
    }
  });

  it('malformed hashes fall back to defaults and never throw', () => {
    const bad = [
      '',
      '#',
      '#s=bad',
      '#c=character',
      '#%E0%A4%A',
      '#s=K7Q2PX&c=<script>&t=../../etc&w=insane&n=-5&v=<b>',
      '#s=K7Q2PX&n=99&l=habitat:%E0%A4%A,palette:hellforge,__proto__:x&f=species:nope',
      `#s=K7Q2PX&l=${'x:y,'.repeat(5000)}`,
    ];
    for (const h of bad) expect(() => decodeShare(h, data)).not.toThrow();
    expect(decodeShare('#c=creature', data)).toBeNull(); // no seed → not a share link
    const s = decodeShare('#s=K7Q2PX&c=<script>&t=nope&w=insane&n=99&v=<b>', data)!;
    expect(s).toMatchObject({ category: 'character', themeChoice: 'any', weirdness: 'mixed', count: 4, version: null });
    expect(decodeShare('#s=k7q2px&n=0', data)!.count).toBe(1);
    const withLocks = decodeShare('#s=K7Q2PX&c=creature&l=habitat:volcanic-salt-flats,bogus:x,palette:no-such-palette', data)!;
    expect(Object.keys(withLocks.locked!)).toEqual(['habitat', 'palette']);
    // Unknown entry ids are ignored at generation time.
    const b = generateBatch(data, {
      category: 'creature',
      themeChoice: 'any',
      weirdness: 'mixed',
      count: 1,
      base: 'K7Q2PX',
      uniqueFrequency: 'sometimes',
      locks: [withLocks.locked],
    })[0];
    expect(data.palettes.some((p) => p.id === b.fields.palette.entryId)).toBe(true);
  });
});

describe('U17 storage failure', () => {
  afterEach(() => {
    delete g.localStorage;
    resetStorageProbe();
  });
  it('with localStorage throwing, loading/saving degrade and generation still works', () => {
    g.localStorage = new Proxy(
      {},
      {
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      },
    );
    resetStorageProbe();
    expect(storageAvailable()).toBe(false);
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadHistory()).toEqual([]);
    expect(loadSaved()).toEqual({});
    expect(saveHistory([one('prop', 'STORE1')])).toBe(false);
    expect(saveSettings(DEFAULT_SETTINGS)).toBe(false);
    const { briefs } = chooseFreshBatch(
      data,
      { category: 'prop', themeChoice: 'any', weirdness: 'mixed', count: 2, uniqueFrequency: 'sometimes' },
      'x',
      [],
    );
    expect(briefs).toHaveLength(2);
    expect(chatText(briefs, DEFAULT_SETTINGS.instruction)).toContain('There are 2 briefs');
  });
  it('corrupt JSON resets only that key', () => {
    const mem = new MemStorage();
    g.localStorage = mem;
    resetStorageProbe();
    saveSaved({ a: one('scene', 'KEEP01') });
    mem.setItem('ab:history', '{not json');
    expect(loadHistory()).toEqual([]);
    expect(mem.getItem('ab:history')).toBeNull();
    expect(Object.keys(loadSaved())).toHaveLength(1);
  });
  it('history is capped at 100, newest first, without duplicates', () => {
    let h: Brief[] = [];
    for (const s of seeds(120, 'hist')) h = addToHistory(h, [one('creature', s)]);
    expect(h).toHaveLength(HISTORY_LIMIT);
    const again = addToHistory(h, [h[50]]);
    expect(again[0].id).toBe(h[50].id);
    expect(new Set(again.map((b) => b.id)).size).toBe(again.length);
  });
});

describe('U18 import / export', () => {
  beforeEach(() => {
    g.localStorage = new MemStorage();
    resetStorageProbe();
  });
  afterEach(() => {
    delete g.localStorage;
    resetStorageProbe();
  });
  it('export → clear → import restores the saved set; re-import adds nothing', () => {
    const saved: Record<string, Brief> = {};
    for (const c of CATS) {
      const b = one(c, `EXP${c.slice(0, 3).toUpperCase()}`.slice(0, 6));
      saved[b.id] = b;
    }
    saveSaved(saved);
    const file = exportSaved(loadSaved());
    expect(exportFileName(new Date(2026, 8, 4))).toBe('art-brief-saved-2026-09-04.json');
    saveSaved({});
    const first = importSaved(loadSaved(), file);
    expect(first.added).toBe(5);
    expect(Object.keys(first.saved).sort()).toEqual(Object.keys(saved).sort());
    saveSaved(first.saved);
    const second = importSaved(loadSaved(), file);
    expect(second.added).toBe(0);
    expect(Object.keys(second.saved)).toHaveLength(5);
  });
  it('rejects files that are not exports', () => {
    expect(() => importSaved({}, 'hello')).toThrow();
    expect(() => importSaved({}, '{"foo":1}')).toThrow();
    expect(importSaved({}, '{"saved":[{"id":"x"}]}').added).toBe(0);
  });
});
