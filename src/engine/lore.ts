import { capitalise, withArticle } from './grammar';
import { fieldEntries } from './generate';
import { givenName } from './names';
import { pickEntry, type PickContext } from './pick';
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
 */

export const LORE_BEATS = ['origin', 'purpose', 'turn', 'now'] as const;
export const LORE_MIN = 50;
export const LORE_MAX = 80;
const ATTEMPTS = 60;
const TRY_AT_LEAST = 8;
export const LORE_TARGET = 65;
/** Who a possessive points at before the story's figure has been introduced ("its maker's heirs"). */
const NPC_FALLBACK: Record<CategoryId, string> = {
  character: 'their mentor',
  prop: 'its maker',
  creature: 'the first hunter',
  building: 'its founder',
  scene: 'the stranger',
};

export const LORE_PLACEHOLDER =
  /\{(f|the|a|al|its|their|l):([a-zA-Z]+)\}|\{(name|first|subj|unique|wearing|traits|npc|npcname|place|era)\}/g;

export interface Lore {
  roll: number;
  text: string;
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
        return brief.fields.name.text;
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
      case 'place':
        st.place ??= pickEntry(tableEntries(data, 'shared.lore-place'), ctx, rng).entry.text;
        return st.place;
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
  // Weirdness makes the brief stranger, not the storyteller: the voice always follows the theme.
  const ctx: PickContext = { theme, weirdness: 'grounded', tags, excludes: new Set(), applyBlock: true };

  // Don't tell the story of a line the card trimmed to fit its word budget (e.g. a dropped Mood).
  const shown = new Set(brief.lines.flatMap((l) => l.slots ?? [l.slot]));
  const hidden = new Set(cat.dropOrder.filter((s) => !shown.has(s)));

  // Try several tellings and keep the one closest to ~65 words inside 50–80, so stories read tight
  // instead of all hugging the cap.
  let best: { text: string; score: number } | null = null;
  for (let a = 0; a < ATTEMPTS; a++) {
    const rng = rngFrom(`${brief.seed}-lore-${roll}-${a}`);
    const st: LoreState = {};
    const parts = LORE_BEATS.map((beat) => {
      const all = tableEntries(data, `${cat.id}.lore-${beat}`);
      if (!all.length) return '';
      const visible = all.filter((e) => !mentionsHidden(e.text, hidden));
      const entries = visible.length ? visible : all;
      return sentence(render(pickEntry(entries, ctx, rng).entry.text, data, cat, brief, st, ctx, rng));
    }).filter(Boolean);
    const text = parts.join(' ');
    const n = countWords(text);
    const outside = n < LORE_MIN ? LORE_MIN - n : n > LORE_MAX ? n - LORE_MAX : 0;
    const score = outside * 100 + Math.abs(n - LORE_TARGET);
    if (!best || score < best.score) best = { text, score };
    if (a >= TRY_AT_LEAST && best.score < 100) break;
  }
  return { roll, text: best!.text };
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

/** Brief text plus its story, for Copy / Copy all. */
export function fullText(brief: Brief): string {
  return brief.lore?.text ? `${brief.plainText}\n\nLore: ${brief.lore.text}` : brief.plainText;
}
