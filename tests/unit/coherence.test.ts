import { describe, expect, it } from 'vitest';
import { fieldEntries, generateBatch } from '../../src/engine/generate';
import { fitsPlace, PLACE_SLOTS } from '../../src/engine/lore';
import { seedFromString } from '../../src/engine/rng';
import type { Brief, CategoryId } from '../../src/engine/types';
import { data } from './helpers';

/**
 * Story lines, the moment to paint and the card's own time/light/behaviour must not contradict where
 * the subject is. Checked on generated text with blunt keyword rules, after removing the shared story
 * fragments that name somewhere else ("a smugglers' cave on the Sword Coast", "the winter the sea froze").
 */
const N = Number(process.env.COHERE_N ?? 300);
const any = (t: Set<string>, xs: string[]) => xs.some((x) => t.has(x));
const RULES: [string, RegExp, (t: Set<string>) => boolean][] = [
  [
    'snow/ice in a hot place',
    /\b((?<!like )snow\w*|blizzard|glacier|avalanche|frozen(?! in mid-air)|ice|winters?|thaw|froze)\b/i,
    (t) => any(t, ['desert', 'jungle', 'tropical', 'volcanic', 'magma', 'brimstone', 'fiend', 'infernal']),
  ],
  [
    'sea/ship/tide away from water',
    /\b(sea(?! of clouds?)|tides?|ships?|sailors?|harbou?r|wreck)\b/i,
    (t) => !any(t, ['ocean', 'coast', 'coral', 'island', 'pirate', 'abyssal', 'river', 'water']),
  ],
  [
    'cave with no rock',
    /\b(caves?|cavern)\b/i,
    (t) =>
      !any(t, [
        'subterranean',
        'cavern',
        'drow',
        'fungal',
        'mountain',
        'coast',
        'glacier',
        'arctic',
        'volcanic',
        'ruins',
        'wilderness',
        'desert',
      ]),
  ],
  [
    'open sky underground or in the deep',
    /\b(sky|skyward|comet|sunbeams?|sunlight|moonlight|aurora|treeline|horizon|silhouetted against the dawn)\b/i,
    (t) => any(t, ['subterranean', 'cavern', 'abyssal']),
  ],
  ['lava away from volcanoes', /\b(lava|magma)\b/i, (t) => !any(t, ['volcanic', 'magma', 'brimstone', 'ash', 'fire'])],
];
const VIOLENT =
  /\b(it (?:hunts|kills|is hunting)|those it kills|ones it kills|strike first|hungry|devouring|tore a caravan|now it hunts)\b/i;

// Shared fragments (names of elsewhere) and idioms, longest first so "the Sea of Fallen Stars" goes before "sea".
const SHARED = Object.values(data.tables)
  .filter((t) => /^shared\.lore-(npc|place|era|faction|venue|city|reward|job|twist)$/.test(t.id))
  .flatMap((t) => t.entries.map((e) => e.text.replace(/\{[^}]+\}/g, '').trim()))
  .filter((s) => s.length > 3)
  .sort((a, b) => b.length - a.length);
const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHARED_RE = SHARED.map((f) => new RegExp(escape(f), 'gi'));
// Story lines marked "elsewhere" name a place they aren't set in; drop whatever they rendered to.
const ELSEWHERE_RE = Object.values(data.tables)
  .flatMap((t) => t.entries.filter((e) => e.elsewhere))
  .map(
    (e) =>
      new RegExp(
        e.text
          .split(/\{[^}]+\}/)
          .map(escape)
          .join('.*?'),
        'gi',
      ),
  );
const strip = (s: string) =>
  [...ELSEWHERE_RE, ...SHARED_RE].reduce((acc, re) => acc.replace(re, ' '), s).replace(/\b\w+ (?:hundred )?winters ago\b/gi, ' ');

/** The card lines that must agree with the place, by category (not the place itself). */
const CARD_LINES: Record<string, string[]> = { creature: ['behaviour'], building: ['light'], scene: ['time', 'composition'] };

function placeTags(b: Brief): Set<string> {
  const cat = data.categories[b.category];
  return new Set(
    (PLACE_SLOTS[b.category] ?? []).flatMap((s) => fieldEntries(data, cat, s, b.fields[s].entryId).flatMap((e) => e.tags ?? [])),
  );
}

describe('story coherence', () => {
  it("stories, moments and the card's own lines never contradict the card's place, or a gentle creature's temper", () => {
    const out: Record<string, string[]> = {};
    const add = (k: string, v: string) => (out[k] ??= []).push(v);
    for (const c of ['creature', 'building', 'scene'] as CategoryId[]) {
      const cat = data.categories[c];
      for (let i = 0; i < N; i++) {
        const [b] = generateBatch(data, {
          category: c,
          themeChoice: 'any',
          weirdness: 'mixed',
          count: 1,
          base: seedFromString(`cohere-${c}-${i}`),
          uniqueFrequency: 'sometimes',
          lore: true,
        });
        const tags = placeTags(b);
        const lines = CARD_LINES[c].map((s) => b.fields[s].text).join(' ');
        // Other card lines (the place itself, materials, the name…) are the card's own choices, not claims
        // the story makes: take them out, longest first, so only story words and the checked lines remain.
        const own = Object.entries(b.fields)
          .filter(([s]) => !CARD_LINES[c].includes(s))
          .map(([, f]) => f.text)
          .filter((t) => t.length > 2)
          .sort((x, y) => y.length - x.length);
        let text = strip(`${b.lore!.text} ${b.lore!.moment ?? ''} ${lines}`);
        for (const o of own) text = text.replace(new RegExp(escape(o), 'gi'), ' ');
        for (const [label, re, wrong] of RULES) {
          if (!wrong(tags)) continue;
          const hit = text.split(/(?<=[.!?:])\s+/).find((sen) => re.test(sen));
          if (hit) add(`${c}: ${label}`, `${hit.match(re)![0]} @ ${[...tags].join(',')} :: ${hit}`);
        }
        const gentle =
          c === 'creature' && fieldEntries(data, cat, 'behaviour', b.fields.behaviour.entryId).some((e) => e.tags?.includes('gentle'));
        if (gentle && VIOLENT.test(text)) add(`${c}: violent story for a gentle creature`, text.slice(0, 160));
      }
    }
    if (process.env.COHERE_SHOW) for (const [k, v] of Object.entries(out)) console.log(`## ${k}\n  ${[...new Set(v)].join('\n  ')}`);
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.length}× e.g. ${v[0]}`]))).toEqual({});
  });

  it('place rules: places needs one of its tags, notPlaces rules its tags out, no place means no check', () => {
    const e = { id: 'x', text: 'x', places: ['coast', 'ocean'], notPlaces: ['desert'] };
    expect(fitsPlace(e, new Set(['coast']))).toBe(true);
    expect(fitsPlace(e, new Set(['forest']))).toBe(false);
    expect(fitsPlace(e, new Set(['coast', 'desert']))).toBe(false);
    expect(fitsPlace(e, null)).toBe(true);
  });
});
