import { capitalise, withArticle } from './grammar';
import { fieldEntries } from './generate';
import { givenName } from './names';
import { fitsPlace, pickEntry, PLACE_SLOTS, weightedPick, type PickContext } from './pick';

export { fitsPlace, PLACE_SLOTS };
import { rngFrom, type Rng } from './rng';
import { withMaterial } from './templates';
import type { Brief, CategoryDef, CategoryId, DataSet, Entry, SlotId } from './types';

/**
 * Lore: a 50–80 word story built from the brief's own lines, told in four beats
 * (origin → purpose → turn → now). Beat phrasings live in data/<category>/lore-<beat>.json and
 * are theme-weighted like every other table, so the tone follows the theme.
 *
 * Placeholders in beat text:
 *   {f:slot} field text        {the:slot} with "the" (skipped for proper nouns)
 *   {a:slot} with a/an   {al:slot} label with a/an ("an Elf")   {its:slot} / {their:slot} replacing a leading article
 *   {l:slot} short label       {name} brief title name   {first} character's first name
 *   {subj} who predicates attach to ("Orrin", "it", "the place")
 *   {unique} the unique trait as a full clause (entry must require "has-unique")
 *   {wearing} outfit + material   {traits} "gentle and patient"
 *   {npc} / {npcname} "a disgraced court wizard named Vharn" on first use, then "Vharn";
 *   never write {npc}'s — before the introduction {npcname}'s becomes "its maker's" (per category)
 *   {place} {era}  from data/lore/place.json and data/lore/era.json
 *   {obj} them/it   {poss} their/its  (lets shared hook lines fit every category)
 */

export const LORE_BEATS = ['origin', 'purpose', 'turn', 'now'] as const;
export const LORE_MIN = 50;
export const LORE_MAX = 80;
const SPINE_THEME_BOOST = 2.5;
const ATTEMPTS = 60;
/** Who a possessive points at before the story's figure has been introduced ("its maker's heirs"). */
const NPC_FALLBACK: Record<CategoryId, string> = {
  character: 'their mentor',
  prop: 'its maker',
  creature: 'the first hunter',
  building: 'its founder',
  scene: 'the stranger',
};

export const LORE_PLACEHOLDER =
  /\{(f|the|a|al|its|their|l):([a-zA-Z]+)\}|\{(name|first|subj|unique|wearing|traits|npc|npcname|place|era|obj|poss)\}/g;

export interface Lore {
  roll: number;
  text: string;
  spine?: string;
  rumour?: string;
  job?: string;
  patron?: string;
  reward?: string;
  twist?: string;
  /** One frozen image to paint, tied to the spine. */
  moment?: string;
}

/** The eight plot spines; turn/now beats and hook lines require one of these tags. */
export const SPINES = ['stolen', 'cursed', 'bargain', 'betrayed', 'lost', 'awakened', 'guardian', 'prophecy'] as const;

/** Keep only lines written for this spine (tables without spine lines pass through unchanged). */
function forSpine(entries: Entry[], spine: string): Entry[] {
  if (!entries.some((e) => e.spines)) return entries;
  const hit = entries.filter((e) => e.spines?.includes(spine));
  return hit.length ? hit : entries;
}

/** Lines for this spine that fit the card's place; a table never comes back empty. */
function forSpineAndPlace(entries: Entry[], spine: string, place: Set<string> | null): Entry[] {
  const spined = forSpine(entries, spine).filter((e) => fitsPlace(e, place));
  if (spined.length) return spined;
  const anywhere = forSpine(
    entries.filter((e) => fitsPlace(e, place)),
    spine,
  );
  return anywhere.length ? anywhere : forSpine(entries, spine);
}

function tableEntries(data: DataSet, id: string): Entry[] {
  return data.tables[id]?.entries ?? [];
}

function stripArticle(s: string): string {
  return s.replace(/^(a|an|the)\s+/i, '');
}

/** Add "the" unless the phrase already has an article or is a proper noun ("Sigil's Great Bazaar", "Menzoberranzan"). */
export function withThe(s: string): string {
  if (/^(the|a|an)\s/i.test(s)) return s;
  const words = s.split(/\s+/);
  const proper = /^[A-Z][\w-]*'s$/.test(words[0]) || words.every((w) => /^[A-Z]/.test(w) || /^(of|the|and)$/.test(w));
  return proper ? s : `the ${s}`;
}

function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

interface LoreState {
  npc?: { role: string; name: string; used: boolean };
  place?: string;
  era?: string;
}

function subjectFor(category: CategoryId, brief: Brief): string {
  if (category === 'character') return brief.fields.name.text.split(' ')[0];
  if (category === 'scene') return 'the place';
  return 'it';
}

function uniqueClause(data: DataSet, cat: CategoryDef, brief: Brief): string {
  const f = brief.fields.unique;
  if (!f || f.entryId === 'none') return '';
  const e = fieldEntries(data, cat, 'unique', f.entryId)[0];
  if (e?.form === 'predicate') return `${subjectFor(cat.id, brief)} ${f.text}`;
  return f.text;
}

function npcName(data: DataSet, brief: Brief, cat: CategoryDef, rng: Rng): string {
  // "Quibella's Staff" → the maker is Quibella.
  const owner = brief.fields.name?.text.match(/^([A-Z][\w'-]+)'s\s/);
  if (cat.id === 'prop' && owner) return owner[1];
  const cultureSlot = cat.id === 'character' ? 'species' : cat.id === 'prop' ? 'origin' : null;
  const tags = cultureSlot ? fieldEntries(data, cat, cultureSlot, brief.fields[cultureSlot].entryId).flatMap((e) => e.tags ?? []) : [];
  const tag = tags.find((t) => t.startsWith('culture-'));
  const culture = data.cultures.find((c) => c.culture === tag) ?? data.cultures[Math.floor(rng() * data.cultures.length)];
  let name = givenName(culture, rng);
  // Never reuse the character's own first name for the second figure.
  if (cat.id === 'character' && name === brief.fields.name.text.split(' ')[0]) name = givenName(culture, rng);
  return name;
}

function render(tpl: string, data: DataSet, cat: CategoryDef, brief: Brief, st: LoreState, ctx: PickContext, rng: Rng): string {
  const field = (slot: SlotId) => {
    if (slot === 'wearing') return withMaterial(brief.fields.outfit?.text ?? '', brief.fields.material?.text ?? '');
    // Outfit/object phrases may carry a {m} material marker; the story names materials separately.
    return (brief.fields[slot]?.text ?? '').replace(/\s*\{m\}/, '');
  };
  const label = (slot: SlotId) => fieldEntries(data, cat, slot, brief.fields[slot]?.entryId ?? '')[0]?.label ?? field(slot);
  const introduced = () => !!st.npc?.used;
  // A possessive can't carry the full introduction ("a witch named Vharn's heirs"), so before the
  // figure has been introduced it points at a stand-in instead ("its maker's heirs").
  if (!introduced()) tpl = tpl.replace(/\{npcname\}'s/g, `${NPC_FALLBACK[cat.id]}'s`);
  return tpl.replace(LORE_PLACEHOLDER, (_m, form: string, slot: string, word: string) => {
    if (form) {
      const t = field(slot);
      switch (form) {
        case 'f':
          return t;
        case 'the':
          return withThe(t);
        case 'a':
          return /^(a|an|the)\s/i.test(t) ? t : withArticle(t);
        case 'its':
          return `its ${stripArticle(t)}`;
        case 'their':
          return `their ${stripArticle(t)}`;
        case 'l':
          return label(slot);
        case 'al':
          return withArticle(label(slot));
      }
    }
    switch (word) {
      case 'name':
        // "near the Ninth Orphanage" mid-sentence; sentence() re-capitalises a sentence start.
        return brief.fields.name.text.replace(/^The /, 'the ');
      case 'first':
        return brief.fields.name.text.split(' ')[0];
      case 'subj':
        return subjectFor(cat.id, brief);
      case 'unique':
        return uniqueClause(data, cat, brief);
      case 'wearing':
        return field('wearing');
      case 'traits':
        return brief.fields.traits ? brief.fields.traits.text.split(', ').join(' and ') : '';
      case 'npc':
      case 'npcname': {
        if (!st.npc) {
          const role = pickEntry(tableEntries(data, 'shared.lore-npc'), ctx, rng).entry.text;
          st.npc = { role, name: npcName(data, brief, cat, rng), used: false };
        }
        if (st.npc.used) return st.npc.name;
        st.npc.used = true;
        return `${withArticle(st.npc.role)} named ${st.npc.name}`;
      }
      case 'obj':
        return cat.id === 'character' ? 'them' : 'it';
      case 'poss':
        return cat.id === 'character' ? 'their' : 'its';
      case 'place': {
        // Half the time build "{venue} in {city}" (hundreds of D&D places); otherwise a hand-written one.
        const venues = tableEntries(data, 'shared.lore-venue');
        const cities = tableEntries(data, 'shared.lore-city');
        if (!st.place && venues.length && cities.length && rng() < 0.55) {
          st.place = `${pickEntry(venues, ctx, rng).entry.text} in ${pickEntry(cities, ctx, rng).entry.text}`;
        }
        st.place ??= pickEntry(tableEntries(data, 'shared.lore-place'), ctx, rng).entry.text;
        return st.place;
      }
      case 'era':
        st.era ??= pickEntry(tableEntries(data, 'shared.lore-era'), ctx, rng).entry.text;
        return st.era;
    }
    return '';
  });
}

function mentionsHidden(tpl: string, hidden: Set<SlotId>): boolean {
  if (!hidden.size) return false;
  for (const m of tpl.matchAll(LORE_PLACEHOLDER)) {
    if (m[2] && hidden.has(m[2])) return true;
    if (m[3] === 'traits' && hidden.has('traits')) return true;
  }
  return false;
}

function sentence(s: string): string {
  const t = capitalise(s.trim().replace(/\s+/g, ' '));
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** Build the story for a brief. Pure: same brief fields + roll always give the same text. */
export function makeLore(data: DataSet, brief: Brief, roll = 0): Lore {
  const cat = data.categories[brief.category];
  const theme = data.themeById[brief.theme] ?? data.themes[0];
  const tags = new Set<string>(cat.baseTags);
  for (const s of cat.slots)
    fieldEntries(data, cat, s.id, brief.fields[s.id]?.entryId ?? '').forEach((e) => (e.tags ?? []).forEach((t) => tags.add(t)));
  if (brief.fields.unique && brief.fields.unique.entryId !== 'none') tags.add('has-unique');
  const placeSlots = PLACE_SLOTS[cat.id];
  const place = placeSlots
    ? new Set(placeSlots.flatMap((s) => fieldEntries(data, cat, s, brief.fields[s]?.entryId ?? '').flatMap((e) => e.tags ?? [])))
    : null;
  // Weirdness makes the brief stranger, not the storyteller: the voice always follows the theme.
  const ctx: PickContext = { theme, weirdness: 'grounded', tags, excludes: new Set(), applyBlock: true, place: place ?? undefined };

  // Don't tell the story of a line the card trimmed to fit its word budget (e.g. a dropped Mood).
  const shown = new Set(brief.lines.flatMap((l) => l.slots ?? [l.slot]));
  const hidden = new Set(cat.dropOrder.filter((s) => !shown.has(s)));

  // The plot spine is rolled first; every later beat and the hook card are told from it.
  // A spine's themes only tilt the odds (x2.5); every plot can happen in every theme.
  const spines = tableEntries(data, 'shared.lore-spine');
  const spineWeights = spines.map((e) => (e.weight ?? 5) * (e.themes?.includes(theme.id) ? SPINE_THEME_BOOST : 1));
  const spineEntry = weightedPick(spines, spineWeights, rngFrom(`${brief.seed}-spine-${roll}`)) ?? spines[0];
  (spineEntry.tags ?? []).forEach((t) => tags.add(t));

  // Take the first telling that fits 50–80 words (preferring "closest to a target" made a handful of
  // short templates win every time).
  let chosen: { text: string; st: LoreState; rng: ReturnType<typeof rngFrom> } | null = null;
  let fallback: { text: string; gap: number; st: LoreState; rng: ReturnType<typeof rngFrom> } | null = null;
  for (let a = 0; a < ATTEMPTS && !chosen; a++) {
    const rng = rngFrom(`${brief.seed}-lore-${roll}-${a}`);
    const st: LoreState = {};
    const parts = LORE_BEATS.map((beat) => {
      const all = forSpineAndPlace(tableEntries(data, `${cat.id}.lore-${beat}`), spineEntry.id, place);
      if (!all.length) return '';
      const visible = all.filter((e) => !mentionsHidden(e.text, hidden));
      const entries = visible.length ? visible : all;
      return sentence(render(pickEntry(entries, ctx, rng).entry.text, data, cat, brief, st, ctx, rng));
    }).filter(Boolean);
    const text = parts.join(' ');
    const n = countWords(text);
    const gap = n < LORE_MIN ? LORE_MIN - n : n > LORE_MAX ? n - LORE_MAX : 0;
    if (gap === 0) chosen = { text, st, rng };
    else if (!fallback || gap < fallback.gap) fallback = { text, gap, st, rng };
  }
  const tell = chosen ?? fallback!;

  // Hook card: same figure/place state as the story, so names carry over into the twist.
  const line = (id: string, asSentence = true) => {
    const spined = forSpineAndPlace(tableEntries(data, id), spineEntry.id, place);
    if (!spined.length) return undefined;
    // Like the story: skip lines about a card line that was trimmed, when there is another choice.
    const visible = spined.filter((e) => !mentionsHidden(e.text, hidden));
    const entries = visible.length ? visible : spined;
    const out = render(pickEntry(entries, ctx, tell.rng).entry.text, data, cat, brief, tell.st, ctx, tell.rng);
    return asSentence ? sentence(out) : capitalise(out.trim());
  };
  const lore: Lore = { roll, text: tell.text, spine: spineEntry.label ?? spineEntry.text };
  const rumour = line(`${cat.id}.lore-rumour`);
  if (rumour) lore.rumour = rumour;
  const job = line('shared.lore-job');
  if (job) lore.job = job;
  const patron = line('shared.lore-faction', false);
  if (patron) lore.patron = patron;
  const reward = line('shared.lore-reward', false);
  if (reward) lore.reward = reward;
  const twist = line('shared.lore-twist');
  if (twist) lore.twist = twist;
  const moment = line(`${cat.id}.lore-moment`);
  if (moment) lore.moment = moment;
  return lore;
}

/** The hook card as plain text lines (for Copy and the ChatGPT prompt). */
export function hookLines(lore: Lore): string[] {
  const out: string[] = [];
  if (lore.spine) out.push(`Plot: ${lore.spine}`);
  if (lore.rumour) out.push(`Rumour: “${lore.rumour}”`);
  if (lore.job) out.push(`Job: ${lore.job}`);
  if (lore.patron) out.push(`Patron: ${lore.patron}`);
  if (lore.reward) out.push(`Reward: ${lore.reward}`);
  if (lore.twist) out.push(`Twist (DM only): ${lore.twist}`);
  return out;
}

export function loreWords(text: string): number {
  return countWords(text);
}

/** Copy of the brief with lore attached (or refreshed after its fields changed). */
export function withLore(data: DataSet, brief: Brief, roll = brief.lore?.roll ?? 0): Brief {
  return { ...brief, lore: makeLore(data, brief, roll) };
}

export function withoutLore(brief: Brief): Brief {
  const rest = { ...brief };
  delete rest.lore;
  return rest;
}

/** The brief without its D&D stat line (art-first copy). */
export function artText(brief: Brief, dnd = false): string {
  return dnd
    ? brief.plainText
    : brief.plainText
        .split('\n')
        .filter((l) => !l.startsWith('D&D: '))
        .join('\n');
}

/** Brief text plus its story (and, with D&D details on, the stat line and DM hook card). */
export function fullText(brief: Brief, dnd = false): string {
  const base = artText(brief, dnd);
  if (!brief.lore?.text) return base;
  const out = [base, '', `Lore: ${brief.lore.text}`];
  if (brief.lore.moment) out.push(`Moment to paint: ${brief.lore.moment}`);
  if (dnd) out.push(...hookLines(brief.lore));
  return out.join('\n');
}
