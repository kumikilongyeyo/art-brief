import type { BriefLine, CategoryDef, CategoryId, FieldValue, SlotId } from './types';

export const WORD_BUDGET = 80;

export interface RenderInput {
  category: CategoryDef;
  fields: Record<SlotId, FieldValue>;
  palette: { name: string; hex: string[] };
  /** Short Title Case label for a slot's entry (species "Firbolg", object "Crown"…). */
  labelOf: (slot: SlotId) => string;
}

export interface RenderedLine extends BriefLine {
  slots: SlotId[];
}

export interface Rendered {
  title: string;
  lines: RenderedLine[];
  plainText: string;
  words: number;
}

interface LineDef {
  label: string;
  slots: SlotId[];
  text: (t: (s: SlotId) => string, input: RenderInput) => string;
}

interface Template {
  title: (t: (s: SlotId) => string, l: (s: SlotId) => string) => string;
  /** Slots the title line's lock button covers. */
  titleLock: SlotId[];
  /** Slots the title line's reroll button rerolls (their dependents follow). */
  titleReroll: SlotId[];
  lines: LineDef[];
}

/** "robe" + "silk" → "robe of silk"; "cape {m} with a hem" → "cape of silk with a hem". */
export function withMaterial(head: string, material: string): string {
  return head.includes('{m}') ? head.replace('{m}', `of ${material}`) : `${head} of ${material}`;
}

const one = (label: string, slot: SlotId): LineDef => ({ label, slots: [slot], text: (t) => t(slot) });
const palette: LineDef = {
  label: 'Palette',
  slots: ['palette'],
  text: (_t, input) => `${input.palette.name} · ${input.palette.hex.join(' ')}`,
};
const unique = one('Unique', 'unique');

export const TEMPLATES: Record<CategoryId, Template> = {
  character: {
    title: (t, l) => `${t('name')} — ${l('species')} ${l('subclass')} ${l('class')}`,
    titleLock: ['name', 'species', 'class', 'subclass'],
    titleReroll: ['species', 'class'],
    lines: [
      one('Background', 'background'),
      { label: 'Look', slots: ['look'], text: (t) => `${t('species')}, ${t('look')}` },
      { label: 'Wearing', slots: ['outfit', 'material'], text: (t) => withMaterial(t('outfit'), t('material')) },
      one('Pose', 'pose'),
      palette,
      one('Traits', 'traits'),
      unique,
    ],
  },
  prop: {
    title: (t) => `${t('name')} — ${withMaterial(t('objectType'), t('material'))}`,
    titleLock: ['name', 'objectType', 'material'],
    titleReroll: ['objectType', 'material'],
    lines: [one('Origin', 'origin'), one('Function', 'function'), one('Details', 'details'), palette, unique],
  },
  creature: {
    title: (t) => `${t('name')} — ${t('creatureType')}, ${t('bodyPlan')}`,
    titleLock: ['name', 'creatureType', 'bodyPlan'],
    titleReroll: ['creatureType', 'bodyPlan'],
    lines: [
      one('Habitat', 'habitat'),
      one('Adaptation', 'adaptation'),
      one('Behaviour', 'behaviour'),
      one('Scale', 'scale'),
      palette,
      unique,
    ],
  },
  building: {
    title: (t) => `${t('name')} — ${t('function')}, ${t('style')} style`,
    titleLock: ['name', 'function', 'style'],
    titleReroll: ['function', 'style'],
    lines: [
      one('Built of', 'material'),
      one('Condition', 'condition'),
      one('Setting', 'setting'),
      one('Signature feature', 'feature'),
      one('Light', 'light'),
      palette,
      unique,
    ],
  },
  scene: {
    title: (t) => t('name'),
    titleLock: ['name'],
    titleReroll: ['name'],
    lines: [
      one('Location', 'location'),
      one('Time & weather', 'time'),
      one('Event', 'event'),
      one('Composition', 'composition'),
      one('Mood', 'mood'),
      palette,
      unique,
    ],
  },
};

const PROTECTED = new Set(['palette', 'unique']);

function wordsIn(s: string): number {
  return s.split(/\s+/).filter((w) => w && w !== '—' && w !== '·' && !/^#[0-9a-f]{6}$/i.test(w)).length;
}

/** Word count of a brief: title + line values; labels and hex codes do not count. */
export function countWords(title: string, lines: BriefLine[]): number {
  return wordsIn(title) + lines.reduce((n, l) => n + wordsIn(l.text), 0);
}

export function renderPlain(title: string, lines: BriefLine[]): string {
  return [title, ...lines.map((l) => `${l.label}: ${l.text}`)].join('\n');
}

export function renderBrief(input: RenderInput): Rendered {
  const tpl = TEMPLATES[input.category.id];
  const t = (s: SlotId) => input.fields[s]?.text ?? '';
  const title = tpl.title(t, input.labelOf);
  let lines: RenderedLine[] = [];
  for (const def of tpl.lines) {
    if (def.slots.some((s) => !input.fields[s] || !input.fields[s].text)) continue;
    lines.push({ label: def.label, text: def.text(t, input), slot: def.slots[0], slots: def.slots });
  }
  // Word budget: drop optional lines in the category's order; title, palette and unique never go.
  for (const slot of input.category.dropOrder) {
    if (countWords(title, lines) <= WORD_BUDGET) break;
    if (PROTECTED.has(slot)) continue;
    lines = lines.filter((l) => !l.slots.includes(slot));
  }
  return { title, lines, plainText: renderPlain(title, lines), words: countWords(title, lines) };
}
