import { withArticle } from './grammar';
import { makeLore } from './lore';
import { buildName } from './names';
import { FUSION_CHANCE, pickEntry, type PickContext } from './pick';
import { cyrb128, rngFrom, type Rng } from './rng';
import { artLines, makeArt } from './art';
import { makeStat } from './stat';
import { renderBrief } from './templates';
import { rollTier } from './unique';
import type {
  Brief,
  CategoryDef,
  CategoryId,
  DataSet,
  Entry,
  FieldValue,
  SlotDef,
  SlotId,
  Theme,
  ThemeId,
  UniqueFrequency,
  Weirdness,
} from './types';

export const BRIEF_SCHEMA_VERSION = 1;
const DIVERSITY_RETRIES = 20;
const NAME_MAX = 60;

export interface Pin {
  entryId: string;
  locked: boolean;
}

export interface Diagnostics {
  maxDepth: number;
  events: { category: CategoryId; theme: ThemeId; weirdness: Weirdness; slot: SlotId; depth: number }[];
}

export interface BatchOptions {
  category: CategoryId;
  themeChoice: ThemeId | 'any';
  weirdness: Weirdness;
  count: number;
  base: string;
  uniqueFrequency: UniqueFrequency;
  /** Locked fields per variation index (slot → entryId). */
  locks?: (Record<SlotId, string> | undefined)[];
  /** Attach a story to every brief. */
  lore?: boolean;
  createdAt?: number;
}

export interface VariationSpec {
  category: CategoryId;
  theme: ThemeId;
  themeChoice: ThemeId | 'any';
  weirdness: Weirdness;
  base: string;
  index: number;
  /** Variation seed: `${base}-${i}` or a diversity retry `${base}-${i}-r${n}`. */
  seed: string;
  uniqueFrequency: UniqueFrequency;
  pins?: Record<SlotId, Pin>;
  rerolls?: Record<SlotId, number>;
  avoidPalettes?: Set<string>;
  avoidPrimary?: Set<string>;
  /** Directly rerolled slots avoid their previous value so a reroll always visibly changes. */
  avoidCurrent?: Record<SlotId, string>;
  createdAt?: number;
}

interface Resolved {
  entryId: string;
  text: string;
  tags: string[];
  excludes: string[];
  label?: string;
  hex?: string[];
  depth: number;
}

// ---------- lookups ----------

function tableEntries(data: DataSet, id: string | undefined): Entry[] {
  return (id && data.tables[id]?.entries) || [];
}

function byId<T extends { id: string }>(list: T[], id: string): T | undefined {
  return list.find((e) => e.id === id);
}

function paletteEntries(data: DataSet): (Entry & { hex: string[] })[] {
  return data.palettes.map((p) => ({ id: p.id, text: p.name, weight: p.weight, tags: p.tags, themes: p.themes, hex: p.hex }));
}

function uniquePool(data: DataSet, slot: SlotDef): Entry[] {
  return [...tableEntries(data, 'shared.unique'), ...tableEntries(data, slot.table)];
}

function fromEntry(e: Entry, depth = 0): Resolved {
  return { entryId: e.id, text: e.text, tags: e.tags ?? [], excludes: e.excludes ?? [], label: e.label, depth };
}

function combine(parts: Resolved[], entryId: string, text: string): Resolved {
  return {
    entryId,
    text,
    tags: parts.flatMap((p) => p.tags),
    excludes: parts.flatMap((p) => p.excludes),
    label: parts[0].label,
    depth: Math.max(...parts.map((p) => p.depth)),
  };
}

/** Rebuild a field from a stored/shared entry id. Returns null for unknown ids. */
export function resolveField(data: DataSet, cat: CategoryDef, slotId: SlotId, entryId: string): Resolved | null {
  const slot = cat.slots.find((s) => s.id === slotId);
  if (!slot || typeof entryId !== 'string' || !entryId) return null;
  const parts = entryId.split('~');
  switch (slot.kind) {
    case 'table': {
      const entries = tableEntries(data, slot.table);
      const found = parts.map((id) => byId(entries, id));
      if (found.some((e) => !e) || parts.length !== (slot.count ?? 1)) return null;
      const rs = (found as Entry[]).map((e) => fromEntry(e));
      return combine(rs, entryId, rs.map((r) => r.text).join(', '));
    }
    case 'material': {
      const mats = tableEntries(data, 'shared.materials');
      if (parts.length === 1) {
        const m = byId(mats, parts[0]);
        return m ? fromEntry(m) : null;
      }
      if (parts.length !== 3) return null;
      const a = byId(mats, parts[0]);
      const c = byId(tableEntries(data, 'shared.connectors'), parts[1]);
      const b = byId(mats, parts[2]);
      if (!a || !b || !c) return null;
      return combine([fromEntry(a), fromEntry(b)], entryId, `${a.text} ${c.text} ${b.text}`);
    }
    case 'palette': {
      const p = byId(paletteEntries(data), entryId);
      return p ? { ...fromEntry(p), hex: p.hex } : null;
    }
    case 'unique': {
      if (entryId === 'none') return { entryId: 'none', text: '', tags: [], excludes: [], depth: 0 };
      const u = byId(uniquePool(data, slot), entryId);
      return u ? fromEntry(u) : null;
    }
    case 'event': {
      const ev = byId(tableEntries(data, slot.table), parts[0]);
      if (!ev) return null;
      const actors = tableEntries(data, slot.actors);
      const a = parts[1] ? byId(actors, parts[1]) : undefined;
      const b = parts[2] ? byId(actors, parts[2]) : undefined;
      if (!a || (ev.text.includes('{b}') && !b)) return null;
      const text = ev.text.replace('{a}', withArticle(a.text)).replace('{b}', b ? withArticle(b.text) : '');
      return combine([fromEntry(ev), fromEntry(a), ...(b ? [fromEntry(b)] : [])], entryId, text);
    }
    case 'name': {
      const clean = entryId.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
      if (!clean || /[<>]/.test(clean)) return null;
      return { entryId: clean, text: clean, tags: [], excludes: [], depth: 0 };
    }
  }
}

// ---------- picking ----------

function pickSlot(
  data: DataSet,
  cat: CategoryDef,
  slot: SlotDef,
  ctx: PickContext,
  rng: Rng,
  spec: VariationSpec,
  fields: Record<SlotId, Resolved>,
): Resolved {
  const prev = spec.avoidCurrent?.[slot.id]?.split('~')[0];
  const avoidPrev = prev ? new Set([prev]) : undefined;
  switch (slot.kind) {
    case 'table': {
      const entries = tableEntries(data, slot.table);
      const avoid = new Set([...(slot.id === cat.primarySlot ? (spec.avoidPrimary ?? []) : []), ...(avoidPrev ?? [])]);
      const first = pickEntry(entries, ctx, rng, avoid);
      const picks = [fromEntry(first.entry, first.depth)];
      for (let k = 1; k < (slot.count ?? 1); k++) {
        const taken = new Set(picks.map((p) => p.entryId));
        const groups = new Set(picks.map((p) => byId(entries, p.entryId)?.group).filter(Boolean));
        const pool = entries.filter((e) => !taken.has(e.id) && !(e.group && groups.has(e.group)));
        const next = pickEntry(pool.length ? pool : entries, ctx, rng);
        picks.push(fromEntry(next.entry, next.depth));
      }
      return combine(picks, picks.map((p) => p.entryId).join('~'), picks.map((p) => p.text).join(', '));
    }
    case 'material': {
      const mats = tableEntries(data, 'shared.materials');
      const mctx = { ...ctx, applyBlock: false };
      const a = pickEntry(mats, mctx, rng, avoidPrev);
      if (rng() >= FUSION_CHANCE[ctx.weirdness]) return fromEntry(a.entry, a.depth);
      const conn = pickEntry(tableEntries(data, 'shared.connectors'), { ...mctx, tags: new Set(), excludes: new Set() }, rng).entry;
      const b = pickEntry(mats, mctx, rng, new Set([a.entry.id]));
      return combine(
        [fromEntry(a.entry, a.depth), fromEntry(b.entry, b.depth)],
        `${a.entry.id}~${conn.id}~${b.entry.id}`,
        `${a.entry.text} ${conn.text} ${b.entry.text}`,
      );
    }
    case 'palette': {
      // Palettes lean hard toward the brief's element/material/mood tags (fire → warm, frost → cool…).
      const p = pickEntry(
        paletteEntries(data),
        { ...ctx, affinity: 2.5 },
        rng,
        new Set([...(spec.avoidPalettes ?? []), ...(avoidPrev ?? [])]),
      );
      return { ...fromEntry(p.entry, p.depth), hex: p.entry.hex };
    }
    case 'unique': {
      const tier = rollTier(spec.uniqueFrequency, spec.weirdness, rng);
      if (tier === 'none') return { entryId: 'none', text: '', tags: [], excludes: [], depth: 0 };
      const all = uniquePool(data, slot);
      const pool = all.filter((e) => e.tier === tier);
      const u = pickEntry(pool.length ? pool : all, ctx, rng, avoidPrev);
      return fromEntry(u.entry, u.depth);
    }
    case 'event': {
      const ev = pickEntry(tableEntries(data, slot.table), ctx, rng, avoidPrev);
      // Skip actors that echo a word already in the event ("a weeping ghost kneels weeping").
      const eventWords = new Set(contentWords(ev.entry.text));
      const all = tableEntries(data, slot.actors);
      const fresh = all.filter((x) => !contentWords(x.text).some((w) => eventWords.has(w)));
      const actors = fresh.length >= 2 ? fresh : all;
      // "{a} holds a lantern high" needs someone with hands; owlbears and gelatinous cubes can't.
      const personOnly = (list: Entry[]) => list.filter((x) => x.tags?.includes('humanoid'));
      const poolFor = (who: 'a' | 'b') => (ev.entry.people?.includes(who) && personOnly(actors).length ? personOnly(actors) : actors);
      const a = pickEntry(poolFor('a'), ctx, rng);
      const parts = [fromEntry(ev.entry, ev.depth), fromEntry(a.entry, a.depth)];
      let id = `${ev.entry.id}~${a.entry.id}`;
      let text = ev.entry.text.replace('{a}', withArticle(a.entry.text));
      if (ev.entry.text.includes('{b}')) {
        const b = pickEntry(poolFor('b'), ctx, rng, new Set([a.entry.id]));
        parts.push(fromEntry(b.entry, b.depth));
        id += `~${b.entry.id}`;
        text = text.replace('{b}', withArticle(b.entry.text));
      }
      return combine(parts, id, text);
    }
    case 'name': {
      const labelSlot = { character: 'species', prop: 'objectType', creature: 'bodyPlan', building: 'function', scene: 'location' }[cat.id];
      const cultureSlot = { character: 'species', prop: 'origin' }[cat.id as 'character' | 'prop'];
      const text = buildName(
        cat.id,
        data,
        {
          label: fields[labelSlot]?.label ?? 'Thing',
          labelTags: fields[labelSlot]?.tags ?? [],
          cultureTags: cultureSlot ? (fields[cultureSlot]?.tags ?? []) : [],
        },
        ctx,
        rng,
      );
      return { entryId: text, text, tags: [], excludes: [], depth: 0 };
    }
  }
}

/** Lower-cased words of 5+ letters, roughly stemmed, for spotting repeated words. */
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.replace(/(ing|ed|es|s)$/, ''));
}

function slotSeed(spec: VariationSpec, slot: SlotId): string {
  return `${spec.seed}-${slot}-${spec.rerolls?.[slot] ?? 0}`;
}

function shortHash(s: string): string {
  return cyrb128(s)[0].toString(36).slice(0, 5).toUpperCase();
}

/** Generate one brief. Pinned slots keep their value; everything else is picked from its own seeded stream. */
export function generateVariation(data: DataSet, spec: VariationSpec, diag?: Diagnostics): Brief {
  const cat = data.categories[spec.category];
  const theme: Theme = data.themeById[spec.theme] ?? data.themes[0];
  const ctx: PickContext = { theme, weirdness: spec.weirdness, tags: new Set(cat.baseTags), excludes: new Set(), applyBlock: true };
  const fields: Record<SlotId, Resolved> = {};
  const locked: Record<SlotId, boolean> = {};

  // Locked/pinned values go into the context first (owner intent wins, even off-theme).
  for (const [slot, pin] of Object.entries(spec.pins ?? {})) {
    const r = resolveField(data, cat, slot, pin.entryId);
    if (!r) continue;
    fields[slot] = r;
    locked[slot] = pin.locked;
    r.tags.forEach((t) => ctx.tags.add(t));
    r.excludes.forEach((t) => ctx.excludes.add(t));
  }

  for (const slot of cat.slots) {
    if (fields[slot.id]) continue;
    const r = pickSlot(data, cat, slot, ctx, rngFrom(slotSeed(spec, slot.id)), spec, fields);
    fields[slot.id] = r;
    r.tags.forEach((t) => ctx.tags.add(t));
    r.excludes.forEach((t) => ctx.excludes.add(t));
    if (diag && r.depth > 0) {
      diag.maxDepth = Math.max(diag.maxDepth, r.depth);
      diag.events.push({ category: cat.id, theme: theme.id, weirdness: spec.weirdness, slot: slot.id, depth: r.depth });
    }
    if (r.depth > 0 && import.meta.env?.MODE === 'development') {
      console.warn(`[art-brief] fallback depth ${r.depth} for ${cat.id}.${slot.id}`, { theme: theme.id, tags: [...ctx.tags] });
    }
  }

  return assemble(data, cat, spec, fields, locked, theme.id);
}

function assemble(
  data: DataSet,
  cat: CategoryDef,
  spec: VariationSpec,
  resolved: Record<SlotId, Resolved>,
  locked: Record<SlotId, boolean>,
  themeId: ThemeId,
): Brief {
  const fields: Record<SlotId, FieldValue> = {};
  for (const s of cat.slots) {
    const r = resolved[s.id];
    fields[s.id] = { entryId: r.entryId, text: r.text, locked: !!locked[s.id] };
  }
  const pal = resolved.palette;
  const palette = { name: pal.text, hex: pal.hex ?? [] };
  const rendered = renderBrief({ category: cat, fields, palette, labelOf: (s) => resolved[s]?.label ?? '' });
  const stat = makeStat(data, cat, spec.seed, resolved, Object.fromEntries(cat.slots.map((sl) => [sl.id, resolved[sl.id]?.text ?? ''])));
  const theme = data.themeById[themeId] ?? data.themes[0];
  const art = makeArt(data, cat, theme, spec.seed, resolved, palette.hex, spec.rerolls?.art ?? 0);
  const [titleLine, ...rest] = rendered.plainText.split('\n');
  const plainText = [titleLine, `D&D: ${stat}`, ...rest, ...artLines(art, cat.id)].join('\n');
  const rerolls = { ...(spec.rerolls ?? {}) };
  const changed = Object.values(rerolls).some((n) => n > 0) || spec.seed !== `${spec.base}-${spec.index}`;
  const baseId = `${spec.base}-${spec.index}`;
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    id: changed ? `${baseId}-${shortHash(cat.slots.map((s) => fields[s.id].entryId).join('|'))}` : baseId,
    seed: spec.seed,
    base: spec.base,
    index: spec.index,
    category: cat.id,
    theme: themeId,
    themeChoice: spec.themeChoice,
    weirdness: spec.weirdness,
    fields,
    palette,
    title: rendered.title,
    lines: rendered.lines,
    plainText,
    stat,
    art,
    dataVersion: data.version,
    createdAt: spec.createdAt ?? 0,
    rerolls,
  };
}

export function rollTheme(data: DataSet, base: string, index: number): ThemeId {
  const r = rngFrom(`${base}-${index}-theme`);
  return data.themes[Math.floor(r() * data.themes.length)].id;
}

/** Generate a batch of 1–4 briefs. Pure: the same options always give the same briefs. */
export function generateBatch(data: DataSet, opts: BatchOptions, diag?: Diagnostics): Brief[] {
  const cat = data.categories[opts.category];
  const count = Math.min(4, Math.max(1, Math.floor(opts.count) || 1));
  const usedPrimary = new Set<string>();
  const usedPalettes = new Set<string>();
  const briefs: Brief[] = [];
  for (let i = 0; i < count; i++) {
    const theme = opts.themeChoice === 'any' ? rollTheme(data, opts.base, i) : opts.themeChoice;
    const pins: Record<SlotId, Pin> = {};
    for (const [slot, entryId] of Object.entries(opts.locks?.[i] ?? {})) pins[slot] = { entryId, locked: true };
    const primaryPinned = !!pins[cat.primarySlot];
    let brief!: Brief;
    let kept!: VariationSpec;
    for (let r = 0; r <= DIVERSITY_RETRIES; r++) {
      kept = {
        category: opts.category,
        theme,
        themeChoice: opts.themeChoice,
        weirdness: opts.weirdness,
        base: opts.base,
        index: i,
        seed: r === 0 ? `${opts.base}-${i}` : `${opts.base}-${i}-r${r}`,
        uniqueFrequency: opts.uniqueFrequency,
        pins,
        avoidPalettes: new Set(usedPalettes),
        avoidPrimary: r === 0 ? undefined : new Set(usedPrimary),
        createdAt: opts.createdAt,
      };
      brief = generateVariation(data, kept);
      if (primaryPinned || !usedPrimary.has(brief.fields[cat.primarySlot].entryId)) break;
    }
    // Fallback diagnostics only for the attempt that was kept.
    if (diag) generateVariation(data, kept, diag);
    usedPrimary.add(brief.fields[cat.primarySlot].entryId);
    usedPalettes.add(brief.fields.palette.entryId);
    briefs.push(opts.lore ? { ...brief, lore: makeLore(data, brief, 0) } : brief);
  }
  return briefs;
}

/** Reroll the given slots plus their unlocked dependents; everything else stays exactly as it is. */
export function rerollSlots(data: DataSet, brief: Brief, slots: SlotId[], uniqueFrequency: UniqueFrequency, diag?: Diagnostics): Brief {
  const cat = data.categories[brief.category];
  const targets = new Set<SlotId>();
  const visit = (s: SlotId) => {
    if (targets.has(s) || brief.fields[s]?.locked) return;
    targets.add(s);
    (cat.dependencies[s] ?? []).forEach(visit);
  };
  slots.forEach(visit);
  const rerolls = { ...brief.rerolls };
  targets.forEach((s) => (rerolls[s] = (rerolls[s] ?? 0) + 1));
  const avoidCurrent: Record<SlotId, string> = {};
  for (const s of slots) if (targets.has(s)) avoidCurrent[s] = brief.fields[s].entryId;
  const pins: Record<SlotId, Pin> = {};
  for (const s of cat.slots) {
    if (!targets.has(s.id)) pins[s.id] = { entryId: brief.fields[s.id].entryId, locked: brief.fields[s.id].locked };
  }
  const next = generateVariation(
    data,
    {
      category: brief.category,
      theme: brief.theme,
      themeChoice: brief.themeChoice,
      weirdness: brief.weirdness,
      base: brief.base,
      index: brief.index,
      seed: brief.seed,
      uniqueFrequency,
      pins,
      rerolls,
      avoidCurrent,
      createdAt: brief.createdAt,
    },
    diag,
  );
  // The story is built from the fields, so it is rebuilt (same telling) when they change.
  return brief.lore ? { ...next, lore: makeLore(data, next, brief.lore.roll) } : next;
}

/** Rebuild a brief from pinned values (share links, lock toggles). Unknown ids are regenerated. */
export function briefFromPins(data: DataSet, spec: Omit<VariationSpec, 'pins'> & { pins: Record<SlotId, Pin> }): Brief {
  return generateVariation(data, spec);
}

/** Return a copy of the brief with the lock flag set on the given slots. */
export function setLocked(brief: Brief, slots: SlotId[], locked: boolean): Brief {
  const fields = { ...brief.fields };
  for (const s of slots) if (fields[s]) fields[s] = { ...fields[s], locked };
  return { ...brief, fields };
}

export function lockedMap(brief: Brief): Record<SlotId, string> {
  const out: Record<SlotId, string> = {};
  for (const [s, f] of Object.entries(brief.fields)) if (f.locked) out[s] = f.entryId;
  return out;
}

/** The underlying table entries behind a field value (for audits and tests). */
export function fieldEntries(data: DataSet, cat: CategoryDef, slotId: SlotId, entryId: string): Entry[] {
  const slot = cat.slots.find((s) => s.id === slotId);
  if (!slot) return [];
  const parts = entryId.split('~');
  switch (slot.kind) {
    case 'table':
      return parts.map((id) => byId(tableEntries(data, slot.table), id)).filter((e): e is Entry => !!e);
    case 'material': {
      const mats = tableEntries(data, 'shared.materials');
      return [parts[0], parts[2]]
        .filter(Boolean)
        .map((id) => byId(mats, id!))
        .filter((e): e is Entry => !!e);
    }
    case 'palette':
      return paletteEntries(data).filter((p) => p.id === entryId);
    case 'unique':
      return entryId === 'none' ? [] : uniquePool(data, slot).filter((e) => e.id === entryId);
    case 'event': {
      const ev = byId(tableEntries(data, slot.table), parts[0]);
      const actors = parts.slice(1).map((id) => byId(tableEntries(data, slot.actors), id));
      return [ev, ...actors].filter((e): e is Entry => !!e);
    }
    case 'name':
      return [];
  }
}

/** A different take on the art direction (shape / light / camera); the brief itself stays the same. */
export function rerollArt(data: DataSet, brief: Brief, uniqueFrequency: UniqueFrequency): Brief {
  const cat = data.categories[brief.category];
  const pins: Record<SlotId, Pin> = {};
  for (const s of cat.slots) pins[s.id] = { entryId: brief.fields[s.id].entryId, locked: brief.fields[s.id].locked };
  const next = generateVariation(data, {
    category: brief.category,
    theme: brief.theme,
    themeChoice: brief.themeChoice,
    weirdness: brief.weirdness,
    base: brief.base,
    index: brief.index,
    seed: brief.seed,
    uniqueFrequency,
    pins,
    rerolls: { ...brief.rerolls, art: (brief.rerolls.art ?? 0) + 1 },
    createdAt: brief.createdAt,
  });
  return brief.lore ? { ...next, lore: brief.lore } : next;
}
