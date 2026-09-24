/**
 * Data validator. Runs in CI before the build; any error blocks the deploy.
 *   npx tsx scripts/validate-data.ts            validate everything
 *   npx tsx scripts/validate-data.ts --only prop,shared.materials   report only errors mentioning these
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { buildDataSet } from '../src/engine/dataset';
import { isBlocked, isOnTheme } from '../src/engine/theme';
import { findArticleErrors } from '../src/engine/grammar';
import { LORE_BEATS, LORE_PLACEHOLDER } from '../src/engine/lore';
import type { CategoryDef, DataSet, Entry, Table } from '../src/engine/types';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DATA = join(ROOT, 'data');

export const MIN_ENTRIES: Record<string, number> = {
  'character.species': 20,
  'character.class': 13,
  'character.subclass': 39,
  'character.background': 20,
  'character.look': 40,
  'character.outfit': 40,
  'character.pose': 30,
  'character.traits': 40,
  'character.unique': 20,
  'prop.object': 35,
  'prop.origin': 15,
  'prop.function': 35,
  'prop.details': 25,
  'prop.unique': 20,
  'creature.type': 14,
  'creature.body': 16,
  'creature.habitat': 18,
  'creature.adaptation': 35,
  'creature.behaviour': 20,
  'creature.scale': 8,
  'creature.unique': 20,
  'building.function': 25,
  'building.style': 18,
  'building.condition': 10,
  'building.setting': 18,
  'building.feature': 30,
  'building.light': 12,
  'building.unique': 20,
  'scene.location': 30,
  'scene.time': 20,
  'scene.event': 30,
  'scene.actors': 30,
  'scene.composition': 15,
  'scene.mood': 15,
  'scene.unique': 20,
  'shared.materials': 80,
  'shared.unique': 60,
  'shared.connectors': 8,
  'shared.item-adjective': 40,
  'shared.creature-first': 30,
  'shared.creature-second': 30,
  'shared.building-epithet': 40,
  'shared.scene-word': 40,
  'shared.lore-npc': 40,
  'shared.lore-place': 30,
  'shared.lore-era': 20,
  'shared.lore-spine': 8,
  'shared.lore-venue': 24,
  'shared.lore-city': 24,
  'shared.lore-job': 40,
  'shared.lore-faction': 30,
  'shared.lore-reward': 30,
  'shared.lore-twist': 48,
  ...Object.fromEntries(['character', 'prop', 'creature', 'building', 'scene'].map((c) => [`${c}.lore-rumour`, 24])),
  ...Object.fromEntries(
    ['character', 'prop', 'creature', 'building', 'scene'].flatMap((c) =>
      ['origin', 'purpose', 'turn', 'now'].map((b) => [`${c}.lore-${b}`, 14]),
    ),
  ),
};

/** Tables whose entries feed a title and therefore need a short `label`. */
const NEEDS_LABEL = [
  'character.species',
  'character.class',
  'character.subclass',
  'prop.object',
  'creature.body',
  'building.function',
  'scene.location',
];
const UNIQUE_TABLES = ['shared.unique', 'character.unique', 'prop.unique', 'creature.unique', 'building.unique', 'scene.unique'];
const CULTURES = [
  'culture-elven',
  'culture-dwarven',
  'culture-infernal',
  'culture-orcish',
  'culture-fey',
  'culture-human',
  'culture-draconic',
  'culture-gnomish',
];
const PRONOUNS = /\b(he|him|his|she|her|hers|himself|herself)\b/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : [];
  });
}

function schemaFor(rel: string): string | null {
  if (rel.startsWith('_drafts/')) return null;
  if (rel === 'tags.json') return 'tags.schema.json';
  if (rel === 'themes.json') return 'themes.schema.json';
  if (rel === 'palettes.json') return 'palettes.schema.json';
  if (rel === 'meta.json') return null;
  if (rel.startsWith('categories/')) return 'category.schema.json';
  if (rel.startsWith('names/') && !rel.startsWith('names/words/')) return 'names.schema.json';
  return 'table.schema.json';
}

export function checkText(where: string, text: string, errors: string[], max = 90) {
  if (text.length > max) errors.push(`${where}: text is ${text.length} chars (max 90): "${text}"`);
  if (/[.,;:!?]$/.test(text)) errors.push(`${where}: trailing punctuation: "${text}"`);
  if (/\s{2,}/.test(text)) errors.push(`${where}: double space: "${text}"`);
  if (text !== text.trim()) errors.push(`${where}: leading/trailing whitespace`);
  if (PRONOUNS.test(text)) errors.push(`${where}: gendered pronoun (use they/their/its): "${text}"`);
  for (const e of findArticleErrors(text)) errors.push(`${where}: article error "${e}"`);
}

export function validateAll(): { errors: string[]; data: DataSet | null } {
  const errors: string[] = [];
  const ajv = new Ajv({ allErrors: true });
  for (const f of readdirSync(join(ROOT, 'schema'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(ROOT, 'schema', f), 'utf8')));
  }

  const files: Record<string, unknown> = {};
  for (const path of walk(DATA)) {
    const rel = relative(DATA, path).split('\\').join('/');
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      errors.push(`${rel}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    const schema = schemaFor(rel);
    if (rel.startsWith('_drafts/')) continue;
    if (schema) {
      const validate = ajv.getSchema(schema)!;
      if (!validate(json)) {
        for (const err of validate.errors ?? []) errors.push(`${rel}: schema ${err.instancePath || '/'} ${err.message}`);
        continue;
      }
    }
    files[rel] = json;
    if (schema === 'table.schema.json') {
      const t = json as Table;
      const expected = rel.replace(/^(names\/words|lore)\//, 'shared/').replace(/\.json$/, '');
      const [cat, slot] = expected.includes('/') ? expected.split('/') : ['shared', expected];
      if (t.id !== `${t.category}.${t.slot}`) errors.push(`${rel}: id "${t.id}" must equal "<category>.<slot>"`);
      if (cat !== t.category && !(cat === 'shared' && t.category === 'shared'))
        errors.push(`${rel}: category "${t.category}" does not match folder "${cat}"`);
      if (cat !== 'shared' && slot !== t.slot) errors.push(`${rel}: slot "${t.slot}" does not match file name "${slot}"`);
    }
  }
  const data = buildDataSet(files);
  const tagOk = (where: string, list: string[] | undefined) => {
    for (const t of list ?? [])
      if (!data.tags.has(t)) errors.push(`${where}: unknown tag "${t}" (add it to data/tags.json or use an existing one)`);
  };
  const themeOk = (where: string, list: string[] | undefined) => {
    for (const t of list ?? []) if (!data.themeById[t]) errors.push(`${where}: unknown theme "${t}"`);
  };

  if (data.themes.length !== 13) errors.push(`themes.json: expected 13 themes, found ${data.themes.length}`);
  for (const th of data.themes) {
    tagOk(`themes.json ${th.id} allowTags`, th.allowTags);
    tagOk(`themes.json ${th.id} blockTags`, th.blockTags);
  }

  for (const id of Object.keys(MIN_ENTRIES)) if (!data.tables[id]) errors.push(`${id}: table is missing`);

  // Per-table rules
  for (const t of Object.values(data.tables)) {
    const seen = new Set<string>();
    const min = MIN_ENTRIES[t.id];
    if (min !== undefined && t.entries.length < min) errors.push(`${t.id}: ${t.entries.length} entries, need at least ${min}`);
    for (const e of t.entries) {
      const w = `${t.id}#${e.id}`;
      if (seen.has(e.id)) errors.push(`${w}: duplicate id`);
      seen.add(e.id);
      tagOk(w, e.tags);
      tagOk(`${w} requires`, e.requires);
      tagOk(`${w} excludes`, e.excludes);
      themeOk(w, e.themes);
      const isLoreBeat = /\.lore-(origin|purpose|turn|now|rumour)$/.test(t.id);
      const isHookLine = /^shared\.lore-(job|twist)$/.test(t.id);
      checkText(w, e.text, errors, isLoreBeat ? 170 : isHookLine ? 130 : 90);
      if (SPINE_TABLES.test(t.id) && !e.spines?.length) errors.push(`${w}: needs "spines" (which plots this line belongs to)`);
      if (t.id !== 'scene.event' && e.people) errors.push(`${w}: "people" only belongs in scene.event`);
      if (!SPINE_TABLES.test(t.id) && e.spines) errors.push(`${w}: "spines" only belongs in turn/now/rumour/job/twist tables`);
      if (e.label) checkText(`${w} label`, e.label, errors);
      for (const x of e.excludes ?? []) if (e.tags?.includes(x)) errors.push(`${w}: both has and excludes tag "${x}"`);
      const placeholders = e.text.match(/\{[^}]*\}/g) ?? [];
      if (isLoreBeat) {
        validateLoreEntry(t, e, data, errors);
      } else if (isHookLine) {
        validateHookEntry(t, e, errors);
      } else if (t.id === 'scene.event') {
        if (!e.text.includes('{a}')) errors.push(`${w}: event text must contain {a}`);
        for (const p of placeholders) if (p !== '{a}' && p !== '{b}') errors.push(`${w}: unknown placeholder ${p}`);
        for (const who of e.people ?? []) if (!e.text.includes(`{${who}}`)) errors.push(`${w}: "people" lists ${who} but the text has no {${who}}`);
      } else if (t.id === 'character.outfit' || t.id === 'prop.object') {
        // Optional {m} marks where "of <material>" goes when the phrase has a trailing clause.
        if (placeholders.some((p) => p !== '{m}') || placeholders.length > 1) errors.push(`${w}: only one {m} placeholder allowed`);
        if (/ (with|over|on|at|from|to|in|by) /.test(e.text) && !placeholders.length)
          errors.push(`${w}: trailing clause — add {m} where "of <material>" should go`);
      } else if (placeholders.length) {
        errors.push(`${w}: placeholders are only allowed in scene.event, character.outfit and prop.object`);
      }
      if (NEEDS_LABEL.includes(t.id) && !e.label) errors.push(`${w}: needs a short "label" (used in the title)`);
      if (UNIQUE_TABLES.includes(t.id) && !e.tier) errors.push(`${w}: unique trait needs "tier"`);
      if (UNIQUE_TABLES.includes(t.id) && !e.form) errors.push(`${w}: unique trait needs "form" (predicate or clause)`);
      if (!UNIQUE_TABLES.includes(t.id) && e.tier) errors.push(`${w}: "tier" only belongs in unique tables`);
      if (t.id === 'shared.materials' && (e.requires?.length || e.excludes?.length))
        errors.push(`${w}: materials are never hard-excluded (no requires/excludes)`);
      if (t.id === 'character.traits' && !e.group) errors.push(`${w}: traits need a "group" (opposites share a group)`);
    }
  }

  // Materials: surreal share
  const mats = data.tables['shared.materials'];
  if (mats) {
    const surreal = mats.entries.filter((e) => e.surreal).length;
    if (surreal < 40) errors.push(`shared.materials: ${surreal} surreal entries, need at least 40`);
  } else errors.push('missing table shared.materials (data/materials.json)');

  // Palettes
  if (data.palettes.length < 50) errors.push(`palettes.json: ${data.palettes.length} palettes, need at least 50`);
  const pids = new Set<string>();
  for (const p of data.palettes) {
    if (pids.has(p.id)) errors.push(`palettes.json#${p.id}: duplicate id`);
    pids.add(p.id);
    tagOk(`palettes.json#${p.id}`, p.tags);
    themeOk(`palettes.json#${p.id}`, p.themes);
    checkText(`palettes.json#${p.id} name`, p.name, errors);
  }

  // Name cultures
  for (const c of CULTURES) if (!data.cultures.some((x) => x.culture === c)) errors.push(`names/: missing culture file for ${c}`);

  // Subclasses: each requires exactly one class tag, each class has 3+
  const classes = data.tables['character.class'];
  const subs = data.tables['character.subclass'];
  if (classes && subs) {
    for (const c of classes.entries) {
      const ct = (c.tags ?? []).filter((t) => t.startsWith('class-'));
      if (ct.length !== 1) errors.push(`character.class#${c.id}: needs exactly one class-* tag`);
      const n = subs.entries.filter((s) => s.requires?.includes(ct[0])).length;
      if (n < 3) errors.push(`character.class#${c.id}: only ${n} subclasses require ${ct[0]}`);
    }
    for (const s of subs.entries) {
      const rt = (s.requires ?? []).filter((t) => t.startsWith('class-'));
      if (rt.length !== 1) errors.push(`character.subclass#${s.id}: must require exactly one class-* tag`);
    }
  }

  // Lore: every beat has enough on-theme phrasings for every theme (and enough without a unique trait).
  for (const cat of Object.values(data.categories)) {
    for (const beat of LORE_BEATS) {
      const t = data.tables[`${cat.id}.lore-${beat}`];
      if (!t) continue;
      for (const theme of data.themes) {
        const ok = t.entries.filter((e) => isOnTheme(e, theme) && !isBlocked(e, theme) && !e.surreal);
        if (ok.length < 4) errors.push(`${t.id}: only ${ok.length} grounded on-theme phrasings for theme "${theme.id}" (need 4)`);
        const noUnique = ok.filter((e) => !(e.requires ?? []).includes('has-unique'));
        if (noUnique.length < 3)
          errors.push(`${t.id}: only ${noUnique.length} phrasings usable without a unique trait for "${theme.id}" (need 3)`);
      }
    }
  }
  // Spines: every plot has enough lines in every theme, for every category.
  const spineIds = (data.tables['shared.lore-spine']?.entries ?? []).map((e) => e.id);
  for (const cat of Object.values(data.categories)) {
    for (const [slot, need, needNoUnique] of [
      ['turn', 3, 0],
      ['now', 3, 2],
      ['rumour', 2, 0],
    ] as const) {
      const t = data.tables[`${cat.id}.lore-${slot}`];
      if (!t || !t.entries.some((e) => e.spines)) continue;
      for (const spine of spineIds) {
        for (const theme of data.themes) {
          const ok = t.entries.filter((e) => e.spines?.includes(spine) && isOnTheme(e, theme) && !isBlocked(e, theme) && !e.surreal);
          if (ok.length < need) errors.push(`${t.id}: spine "${spine}" has ${ok.length} lines for theme "${theme.id}" (need ${need})`);
          const free = ok.filter((e) => !(e.requires ?? []).includes('has-unique'));
          if (free.length < needNoUnique) errors.push(`${t.id}: spine "${spine}" has ${free.length} lines without a unique trait for "${theme.id}" (need ${needNoUnique})`);
        }
      }
    }
  }
  for (const id of ['shared.lore-job', 'shared.lore-twist']) {
    const t = data.tables[id];
    if (!t) continue;
    for (const spine of spineIds) {
      for (const cat of Object.values(data.categories)) {
        const ok = t.entries.filter((e) => e.spines?.includes(spine) && !(e.excludes ?? []).some((x) => cat.baseTags.includes(x)) && !(e.requires ?? []).length);
        if (ok.length < 3) errors.push(`${id}: spine "${spine}" has ${ok.length} lines usable for ${cat.id} (need 3)`);
      }
    }
  }

  for (const id of ['shared.lore-npc', 'shared.lore-place', 'shared.lore-era', 'shared.lore-faction', 'shared.lore-reward', 'shared.lore-venue', 'shared.lore-city']) {
    const t = data.tables[id];
    if (!t) continue;
    for (const theme of data.themes) {
      const ok = t.entries.filter((e) => isOnTheme(e, theme) && !isBlocked(e, theme) && !e.surreal);
      if (ok.length < 3) errors.push(`${id}: only ${ok.length} grounded on-theme entries for "${theme.id}" (need 3)`);
    }
  }

  // Categories
  const uniqueTags: Set<string>[] = [];
  for (const cat of Object.values(data.categories)) validateCategory(cat, data, errors, tagOk, uniqueTags);
  // Shared unique traits are filtered per category on purpose; each must still land in at least one.
  for (const e of data.tables['shared.unique']?.entries ?? []) {
    const req = e.requires ?? [];
    if (req.length && uniqueTags.length && !uniqueTags.some((av) => req.some((r) => av.has(r))))
      errors.push(`shared.unique#${e.id}: requires [${req.join(', ')}] which no category can provide`);
  }

  return { errors, data };
}

const CHARACTER_ONLY = new Set(['first', 'wearing', 'traits']);
const SPINE_TABLES = /\.lore-(turn|now|rumour)$|^shared\.lore-(job|twist)$/;
/** Hook lines are shared by every category, so they may only use category-neutral placeholders. */
const HOOK_OK = new Set(['name', 'subj', 'obj', 'poss', 'npc', 'npcname', 'place', 'era']);

function validateHookEntry(t: Table, e: Entry, errors: string[]) {
  const w = `${t.id}#${e.id}`;
  const known = new Set<string>();
  for (const m of e.text.matchAll(LORE_PLACEHOLDER)) {
    known.add(m[0]);
    if (m[2] || !HOOK_OK.has(m[3])) errors.push(`${w}: ${m[0]} is not allowed in shared hook lines (use {name} {subj} {obj} {poss} {npc} {npcname} {place} {era})`);
  }
  for (const p of e.text.match(/\{[^}]*\}/g) ?? []) if (!known.has(p)) errors.push(`${w}: unknown placeholder ${p}`);
  if (e.text.includes("{npc}'s")) errors.push(`${w}: {npc}'s reads badly on first use`);
  if (e.requires?.length) errors.push(`${w}: hook lines use "excludes" with category tags (cat-scene…) instead of requires`);
}

function validateLoreEntry(t: Table, e: Entry, data: DataSet, errors: string[]) {
  const w = `${t.id}#${e.id}`;
  const cat = data.categories[t.category as keyof typeof data.categories];
  if (!cat) return errors.push(`${w}: lore tables must belong to a category`);
  const slots = new Set(cat.slots.map((s) => s.id));
  const known = new Set<string>();
  for (const m of e.text.matchAll(LORE_PLACEHOLDER)) {
    known.add(m[0]);
    if (m[2] && !slots.has(m[2]) && !(m[2] === 'wearing' && cat.id === 'character'))
      errors.push(`${w}: ${m[0]} — "${m[2]}" is not a ${cat.id} slot`);
    if (m[3] && CHARACTER_ONLY.has(m[3]) && cat.id !== 'character') errors.push(`${w}: ${m[0]} is only for characters`);
  }
  for (const p of e.text.match(/\{[^}]*\}/g) ?? []) if (!known.has(p)) errors.push(`${w}: unknown placeholder ${p}`);
  if (e.text.includes("{npc}'s"))
    errors.push(`${w}: {npc}'s reads badly on first use ("a witch named Vharn's"); rephrase or use {npcname}'s after {npc}`);
  const usesUnique = e.text.includes('{unique}');
  const needsUnique = (e.requires ?? []).includes('has-unique');
  if (usesUnique !== needsUnique) errors.push(`${w}: entries using {unique} must have requires ["has-unique"] (and only those)`);
  if (/(^|[^{])\b(he|she|his|her|him)\b/i.test(e.text.replace(LORE_PLACEHOLDER, ''))) errors.push(`${w}: gendered pronoun`);
}

function poolFor(slot: CategoryDef['slots'][number], data: DataSet): Entry[] | null {
  if (slot.kind === 'material') return data.tables['shared.materials']?.entries ?? [];
  if (slot.kind === 'palette') return data.palettes.map((p) => ({ id: p.id, text: p.name, tags: p.tags, themes: p.themes }));
  if (slot.kind === 'name') return null;
  if (slot.kind === 'unique') return [...(data.tables['shared.unique']?.entries ?? []), ...(data.tables[slot.table!]?.entries ?? [])];
  return data.tables[slot.table!]?.entries ?? [];
}

function validateCategory(
  cat: CategoryDef,
  data: DataSet,
  errors: string[],
  tagOk: (w: string, l?: string[]) => void,
  uniqueTags: Set<string>[],
) {
  const w = `categories/${cat.id}.json`;
  tagOk(`${w} baseTags`, cat.baseTags);
  const slotIds = cat.slots.map((s) => s.id);
  if (!slotIds.includes(cat.primarySlot)) errors.push(`${w}: primarySlot "${cat.primarySlot}" not in slots`);
  for (const s of [...cat.optionalSlots, ...cat.dropOrder]) if (!slotIds.includes(s)) errors.push(`${w}: unknown slot "${s}"`);
  for (const [k, deps] of Object.entries(cat.dependencies)) {
    for (const s of [k, ...deps]) if (!slotIds.includes(s)) errors.push(`${w}: dependency uses unknown slot "${s}"`);
  }
  const missing = new Set<string>();
  for (const s of cat.slots) {
    if ((s.kind === 'table' || s.kind === 'event' || s.kind === 'unique') && !data.tables[s.table!]) {
      errors.push(`${w}: slot "${s.id}" uses missing table "${s.table}"`);
      missing.add(s.id);
    }
    if (s.kind === 'event' && !data.tables[s.actors!]) {
      errors.push(`${w}: slot "${s.id}" uses missing actors table "${s.actors}"`);
      missing.add(s.id);
    }
  }

  // Requires must be satisfiable by tags that earlier slots (or the base) can provide.
  const available = new Set(cat.baseTags);
  const shared = new Set(data.tables['shared.unique']?.entries ?? []);
  for (const s of cat.slots) {
    const pool = poolFor(s, data) ?? [];
    if (s.kind === 'unique') uniqueTags.push(new Set(available));
    for (const e of pool) {
      if (shared.has(e)) continue;
      const req = e.requires ?? [];
      if (req.length && !req.some((r) => available.has(r)))
        errors.push(`${w}: slot "${s.id}" entry "${e.id}" requires [${req.join(', ')}] but no earlier slot can provide it`);
    }
    if (s.kind === 'event' && !missing.has(s.id)) {
      for (const e of data.tables[s.actors!].entries) {
        const req = e.requires ?? [];
        if (req.length && !req.some((r) => available.has(r))) errors.push(`${w}: actor "${e.id}" has unsatisfiable requires`);
      }
    }
    pool.forEach((e) => (e.tags ?? []).forEach((t) => available.add(t)));
  }

  // Every category x theme: each required slot has >= 3 on-theme, unblocked entries.
  for (const theme of data.themes) {
    for (const s of cat.slots) {
      if (cat.optionalSlots.includes(s.id) || s.kind === 'name' || s.kind === 'unique' || missing.has(s.id)) continue;
      const pool = poolFor(s, data)!;
      const blockApplies = s.kind !== 'material';
      const ok = pool.filter((e) => isOnTheme(e, theme) && !e.surreal && (!blockApplies || !isBlocked(e, theme)));
      // Primary slot and palette need room for 4 distinct picks per batch (diversity + no repeated palette).
      const need = s.id === cat.primarySlot || s.kind === 'palette' ? 6 : 3;
      if (ok.length < need)
        errors.push(`${w}: slot "${s.id}" has only ${ok.length} grounded on-theme entries for theme "${theme.id}" (need ${need})`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx > 0 ? process.argv[onlyIdx + 1].split(',') : null;
  const { errors } = validateAll();
  const shown = only ? errors.filter((e) => only.some((o) => e.includes(o))) : errors;
  if (shown.length) {
    console.error(shown.map((e) => `  ✗ ${e}`).join('\n'));
    console.error(`\n${shown.length} data error(s)${only ? ` matching ${only.join(',')}` : ''}.`);
    process.exit(1);
  }
  console.log(only ? `Data OK for ${only.join(',')} (${errors.length} errors elsewhere).` : 'Data OK.');
}
