import { describe, expect, it } from 'vitest';
import { storyText, DEFAULT_STORY_INSTRUCTION } from '../../src/chat';
import { generateBatch, rerollSlots } from '../../src/engine/generate';
import { findArticleErrors } from '../../src/engine/grammar';
import { artText, fullText, loreWords, LORE_MAX, LORE_MIN, makeLore, withLore, withoutLore, withThe } from '../../src/engine/lore';
import { WEIRDNESS, type Brief } from '../../src/engine/types';
import { CATS, data, one, seeds } from './helpers';

const PRONOUN = /\b(he|him|his|she|her|hers)\b/i;

/** Card lines the story can quote (not the name or palette), with any {m} marker removed. */
function quotable(b: Brief): string[] {
  return Object.entries(b.fields)
    .filter(([slot, f]) => !['name', 'palette', 'unique', 'traits'].includes(slot) && f.text && f.entryId !== 'none')
    .map(([, f]) => f.text.replace(/\s*\{m\}/, ''));
}

describe('lore sweep: every category x theme x weirdness', () => {
  const problems: string[] = [];
  const lengths: number[] = [];
  let lowUse = 0;
  let total = 0;
  for (const c of CATS) {
    for (const t of data.themes) {
      for (const w of WEIRDNESS) {
        for (const base of seeds(4, `lore-${c}-${t.id}-${w}`)) {
          for (const b of generateBatch(data, {
            category: c,
            themeChoice: t.id,
            weirdness: w,
            count: 3,
            base,
            uniqueFrequency: 'sometimes',
            lore: true,
          })) {
            total++;
            const text = b.lore!.text;
            const n = loreWords(text);
            lengths.push(n);
            const where = `${c}/${t.id}/${w}: "${text}"`;
            if (n < LORE_MIN || n > LORE_MAX) problems.push(`${n} words — ${where}`);
            if (/[{}]|undefined|null|NaN/.test(text)) problems.push(`placeholder — ${where}`);
            if (/ {2,}| ,| \.|\.\.(?!\.)|\b(the|a|an) (the|a|an)\b/i.test(text)) problems.push(`spacing/article doubling — ${where}`);
            if (PRONOUN.test(text)) problems.push(`gendered pronoun — ${where}`);
            for (const g of findArticleErrors(text)) problems.push(`a/an "${g}" — ${where}`);
            if (!/[.!?…]$/.test(text)) problems.push(`no final punctuation — ${where}`);
            const used = quotable(b).filter((q) => text.includes(q)).length;
            if (used < 2) lowUse++;
          }
        }
      }
    }
  }
  it('every story is 50–80 words and clean', () => {
    expect(total).toBe(5 * 13 * 3 * 4 * 3);
    expect(problems.slice(0, 8)).toEqual([]);
  });
  it('stories are built from the card: at least two card lines quoted in 95%+ of stories', () => {
    expect(lowUse / total).toBeLessThanOrEqual(0.05);
  });
  it('lengths centre on a tight telling, not the cap', () => {
    const sorted = [...lengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeGreaterThanOrEqual(56);
    expect(median).toBeLessThanOrEqual(74);
  });
});

describe('lore regressions', () => {
  it('never tells the story of a line the card trimmed (e.g. a dropped Mood)', () => {
    let quotedBefore = 0;
    for (const c of CATS) {
      const cat = data.categories[c];
      for (const base of seeds(150, `hidden-${c}`)) {
        const b = one(c, base);
        for (const slot of cat.dropOrder.filter((x) => x !== 'traits')) {
          // Only promised when every beat has a telling that doesn't use this line.
          const avoidable = ['origin', 'purpose', 'turn', 'now'].every((beat) =>
            (data.tables[`${c}.lore-${beat}`]?.entries ?? []).some(
              (e) => !new RegExp(`\\{(f|the|a|al|its|their|l):${slot}\\}`).test(e.text),
            ),
          );
          if (!avoidable) continue;
          const text = b.fields[slot].text.replace(/\s*\{m\}/, '');
          for (let roll = 0; roll < 3; roll++) if (makeLore(data, b, roll).text.includes(text)) quotedBefore++;
          // Same card with that line trimmed, as the word budget would do.
          const trimmed = { ...b, lines: b.lines.filter((l) => !(l.slots ?? [l.slot]).includes(slot)) };
          for (let roll = 0; roll < 3; roll++) expect(makeLore(data, trimmed, roll).text, `${c}: trimmed ${slot}`).not.toContain(text);
        }
      }
    }
    expect(quotedBefore).toBeGreaterThan(50); // the check is meaningful: those lines do get quoted when shown
  });
});

describe('lore behaviour', () => {
  it.each(CATS)('%s: deterministic, and a reroll tells it differently', (c) => {
    let differ = 0;
    const ss = seeds(40, `lore-det-${c}`);
    for (const s of ss) {
      const b = one(c, s);
      expect(makeLore(data, b, 0)).toEqual(makeLore(data, b, 0));
      if (makeLore(data, b, 0).text !== makeLore(data, b, 1).text) differ++;
    }
    expect(differ / ss.length).toBeGreaterThanOrEqual(0.95);
  });

  it.each(CATS)('%s: rerolling a line keeps the story and rebuilds it from the new fields', (c) => {
    const cat = data.categories[c];
    for (const s of seeds(20, `lore-rr-${c}`)) {
      const b = withLore(data, one(c, s), 2);
      const next = rerollSlots(data, b, [cat.slots[3].id], 'sometimes');
      expect(next.lore?.roll).toBe(2);
      expect(next.lore).toEqual(makeLore(data, next, 2));
    }
  });

  it('withoutLore and fullText', () => {
    const b = withLore(data, one('prop', 'FULL01'));
    expect(fullText(b)).not.toContain('Plot:'); // art-first: DM notes only with D&D details on
    expect(fullText(b)).not.toContain('D&D: ');
    const text = fullText(b, true);
    expect(text.startsWith(`${b.plainText}\n\nLore: ${b.lore!.text}`)).toBe(true);
    expect(text).toContain(`Plot: ${b.lore!.spine}`);
    if (b.lore!.twist) expect(text).toContain(`Twist (DM only): ${b.lore!.twist}`);
    expect(withoutLore(b).lore).toBeUndefined();
    expect(fullText(withoutLore(b))).toBe(artText(b));
  });

  it('the story prompt carries both the brief and the draft', () => {
    const b = withLore(data, one('creature', 'STORY1'));
    const t = storyText(b, DEFAULT_STORY_INSTRUCTION);
    expect(t).toContain(`BRIEF:\n${artText(b)}`);
    expect(t).toContain(`LORE DRAFT:\n${b.lore!.text}`);
    expect(storyText(b, 'Just make it good.')).toContain(b.lore!.text);
  });

  it('withThe leaves proper nouns alone', () => {
    expect(withThe("Sigil's Great Bazaar")).toBe("Sigil's Great Bazaar");
    expect(withThe('Menzoberranzan')).toBe('Menzoberranzan');
    expect(withThe('Shadowfell mourning cult')).toBe('the Shadowfell mourning cult');
    expect(withThe('halfling river-barge peddlers')).toBe('the halfling river-barge peddlers');
    expect(withThe('a smugglers’ den')).toBe('a smugglers’ den');
  });
});
