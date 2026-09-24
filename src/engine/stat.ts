import { rngFrom, type Rng } from './rng';
import type { CategoryDef, DataSet, Entry, SlotId, Tier } from './types';

/**
 * One D&D-flavoured stat tag per brief, derived from the card so it agrees with it:
 * a legendary unique trait makes a legendary item / high-CR creature / high-level character.
 */

type TierOrNone = Tier | 'none';

interface StatField {
  entryId: string;
  tags: string[];
  label?: string;
}

function pick<T>(list: T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length)];
}

function weighted<T>(pairs: [T, number][], rng: Rng): T {
  const total = pairs.reduce((n, [, w]) => n + w, 0);
  let r = rng() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
}

const RARITY: Record<TierOrNone, [string, number][]> = {
  none: [
    ['common', 3],
    ['uncommon', 4],
    ['rare', 2],
  ],
  minor: [
    ['uncommon', 3],
    ['rare', 4],
    ['very rare', 1],
  ],
  notable: [
    ['rare', 3],
    ['very rare', 4],
    ['legendary', 1],
  ],
  legendary: [
    ['very rare', 1],
    ['legendary', 4],
    ['artifact', 1],
  ],
};
const ATTUNE: Record<string, number> = { common: 0, uncommon: 0.3, rare: 0.55, 'very rare': 0.7, legendary: 0.85, artifact: 1 };
const ATTUNE_BY = ['a spellcaster', 'a cleric', 'a druid', 'a paladin', 'a warlock', 'a wizard', 'a bard', 'a sorcerer', 'a ranger'];

function propStat(f: Record<SlotId, StatField>, tier: TierOrNone, rng: Rng): string {
  const obj = f.objectType;
  const label = (obj?.label ?? '').toLowerCase();
  const kind = obj?.tags.includes('weapon')
    ? 'Weapon'
    : obj?.tags.includes('armour')
      ? 'Armor'
      : ['staff', 'wand', 'rod', 'ring'].includes(label)
        ? label.charAt(0).toUpperCase() + label.slice(1)
        : 'Wondrous item';
  const rarity = weighted(RARITY[tier], rng);
  let att = '';
  if (rng() < ATTUNE[rarity]) att = rng() < 0.4 ? ` (requires attunement by ${pick(ATTUNE_BY, rng)})` : ' (requires attunement)';
  return `${kind}, ${rarity}${att}`;
}

const SIZE_BY_TAG: Record<string, string> = { tiny: 'Tiny', small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
const GARGANTUAN = /whale|cathedral|galley|mountain|castle/;
const CR_BY_SIZE: Record<string, string[]> = {
  Tiny: ['0', '1/8', '1/4', '1/2', '1', '2'],
  Small: ['1/4', '1/2', '1', '2', '3'],
  Medium: ['1', '2', '3', '4', '5', '6', '8'],
  Large: ['3', '4', '5', '6', '7', '8', '9', '10'],
  Huge: ['7', '9', '11', '13', '15', '17'],
  Gargantuan: ['12', '15', '18', '20', '22', '24'],
};
const ALIGN_BY_TYPE: Record<string, string[]> = {
  aberration: ['lawful evil', 'neutral evil', 'chaotic evil'],
  beast: ['unaligned'],
  plant: ['unaligned', 'neutral'],
  ooze: ['unaligned'],
  construct: ['unaligned', 'lawful neutral'],
  celestial: ['lawful good', 'neutral good', 'chaotic good'],
  dragon: ['lawful evil', 'chaotic evil', 'lawful good', 'chaotic good', 'neutral'],
  elemental: ['neutral'],
  fey: ['chaotic neutral', 'neutral', 'chaotic good', 'chaotic evil'],
  fiend: ['lawful evil', 'chaotic evil', 'neutral evil'],
  giant: ['chaotic evil', 'neutral good', 'lawful evil', 'chaotic neutral'],
  humanoid: ['any alignment'],
  monstrosity: ['unaligned', 'neutral evil', 'chaotic evil'],
  undead: ['neutral evil', 'chaotic evil', 'lawful evil'],
};

export function creatureSize(scale: StatField | undefined, scaleText: string): string {
  if (GARGANTUAN.test(scaleText)) return 'Gargantuan';
  const tag = scale?.tags.find((t) => SIZE_BY_TAG[t]);
  return tag ? SIZE_BY_TAG[tag] : 'Medium';
}

function creatureStat(f: Record<SlotId, StatField>, texts: Record<SlotId, string>, tier: TierOrNone, rng: Rng): string {
  const size = creatureSize(f.scale, texts.scale ?? '');
  const crs = CR_BY_SIZE[size];
  // Unique traits push toward the top of the size's range.
  const lo = tier === 'legendary' ? Math.floor(crs.length / 2) : tier === 'notable' ? 1 : 0;
  const hi = tier === 'none' ? Math.ceil(crs.length * 0.7) : crs.length;
  const cr = crs[lo + Math.floor(rng() * Math.max(1, hi - lo))];
  const type = f.creatureType?.entryId ?? 'monstrosity';
  const align = pick(ALIGN_BY_TYPE[type] ?? ['unaligned'], rng);
  const legendary = tier === 'legendary' && Number(cr) >= 10 ? ' · legendary actions' : '';
  return `${size} ${texts.creatureType ?? type}, ${align} · CR ${cr}${legendary}`;
}

const GOOD = /gentle|forgiving|openhanded|humble|loyal|trusting|brave|sunny|honest|content/;
const EVIL = /cruel|vengeful|greedy|arrogant|paranoid|vain/;
const LAW = /formal|meticulous|devout|honest|logical|humourless|solemn|patient|calm/;
const CHAOS = /chaotic|prankish|fickle|reckless|irreverent|restless|playful|hot-tempered|superstitious/;
const LEVELS: Record<TierOrNone, [number, number]> = { none: [1, 8], minor: [3, 10], notable: [5, 14], legendary: [11, 20] };

export function alignmentFromTraits(traits: string): string {
  const good = (traits.match(new RegExp(GOOD, 'g')) ?? []).length - (traits.match(new RegExp(EVIL, 'g')) ?? []).length;
  const law = (traits.match(new RegExp(LAW, 'g')) ?? []).length - (traits.match(new RegExp(CHAOS, 'g')) ?? []).length;
  const ethic = law > 0 ? 'lawful' : law < 0 ? 'chaotic' : 'neutral';
  const moral = good > 0 ? 'good' : good < 0 ? 'evil' : 'neutral';
  return ethic === 'neutral' && moral === 'neutral' ? 'true neutral' : ethic === moral ? ethic : `${ethic} ${moral}`;
}

function characterStat(texts: Record<SlotId, string>, tier: TierOrNone, rng: Rng): string {
  const [lo, hi] = LEVELS[tier];
  const level = lo + Math.floor(rng() * (hi - lo + 1));
  return `Level ${level} · ${alignmentFromTraits(texts.traits ?? '')}`;
}

const TIER_LEVELS = ['', '1–4', '5–10', '11–16', '17–20'];
const SITE_TIER: Record<TierOrNone, [number, number][]> = {
  none: [
    [1, 3],
    [2, 2],
  ],
  minor: [
    [1, 2],
    [2, 3],
    [3, 1],
  ],
  notable: [
    [2, 3],
    [3, 2],
  ],
  legendary: [
    [3, 2],
    [4, 2],
  ],
};

function buildingStat(tier: TierOrNone, rng: Rng): string {
  const t = weighted(SITE_TIER[tier], rng);
  const danger = weighted<string>(
    [
      ['low', t <= 1 ? 3 : 1],
      ['moderate', 3],
      ['high', t >= 2 ? 3 : 1],
      ['deadly', t >= 3 ? 2 : 0.3],
    ],
    rng,
  );
  return `Adventure site · Tier ${t} (levels ${TIER_LEVELS[t]}) · danger: ${danger}`;
}

function sceneStat(texts: Record<SlotId, string>, tier: TierOrNone, rng: Rng): string {
  const tense = /battle|betrayal|doomed|frantic|violent|dread|panic|war|desperate/.test(texts.mood ?? '');
  const diff = weighted<string>(
    [
      ['Easy', tense ? 0.5 : 2],
      ['Medium', 3],
      ['Hard', tense ? 4 : 2],
      ['Deadly', tier === 'legendary' ? 3 : tense ? 1.5 : 0.5],
    ],
    rng,
  );
  const t = weighted(SITE_TIER[tier], rng);
  return `Encounter · ${diff} · levels ${TIER_LEVELS[t]}`;
}

/** Deterministic: depends only on the seed and the fields that shape it. */
export function makeStat(
  data: DataSet,
  cat: CategoryDef,
  seed: string,
  fields: Record<SlotId, StatField>,
  texts: Record<SlotId, string>,
): string {
  const uniq = fields.unique?.entryId && fields.unique.entryId !== 'none' ? fields.unique.entryId : null;
  const uniqueEntry: Entry | undefined = uniq
    ? [...(data.tables['shared.unique']?.entries ?? []), ...(data.tables[`${cat.id}.unique`]?.entries ?? [])].find((e) => e.id === uniq)
    : undefined;
  const tier: TierOrNone = uniqueEntry?.tier ?? 'none';
  const key = ['unique', 'objectType', 'scale', 'creatureType', 'traits', 'mood'].map((s) => fields[s]?.entryId ?? '').join('|');
  const rng = rngFrom(`${seed}-stat-${key}`);
  switch (cat.id) {
    case 'prop':
      return propStat(fields, tier, rng);
    case 'creature':
      return creatureStat(fields, texts, tier, rng);
    case 'character':
      return characterStat(texts, tier, rng);
    case 'building':
      return buildingStat(tier, rng);
    case 'scene':
      return sceneStat(texts, tier, rng);
  }
}
