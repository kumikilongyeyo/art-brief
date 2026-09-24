export type CategoryId = 'character' | 'prop' | 'creature' | 'building' | 'scene';
export type ThemeId = string;
export type SlotId = string;
export type Weirdness = 'grounded' | 'mixed' | 'wild';
export type UniqueFrequency = 'never' | 'sometimes' | 'often';
export type Tier = 'minor' | 'notable' | 'legendary';

export const CATEGORY_IDS: CategoryId[] = ['character', 'prop', 'creature', 'building', 'scene'];
export const WEIRDNESS: Weirdness[] = ['grounded', 'mixed', 'wild'];

export interface Entry {
  id: string;
  text: string;
  label?: string;
  weight?: number;
  tags?: string[];
  themes?: string[];
  requires?: string[];
  excludes?: string[];
  surreal?: boolean;
  tier?: Tier;
  group?: string;
  /** Unique traits: 'predicate' needs a subject ("grows warm…"), 'clause' stands alone ("its eyes glow…"). */
  form?: 'predicate' | 'clause';
  /** Story lines that belong to particular plot spines (turn, now, rumour, job, twist). */
  spines?: string[];
}

export interface Table {
  id: string;
  category: CategoryId | 'shared';
  slot: string;
  entries: Entry[];
}

export interface Palette {
  id: string;
  name: string;
  hex: string[];
  weight?: number;
  tags?: string[];
  themes?: string[];
}

export interface Theme {
  id: ThemeId;
  name: string;
  allowTags: string[];
  blockTags: string[];
}

export type SlotKind = 'table' | 'material' | 'palette' | 'unique' | 'name' | 'event';

export interface SlotDef {
  id: SlotId;
  kind: SlotKind;
  table?: string;
  actors?: string;
  count?: number;
}

export interface CategoryDef {
  id: CategoryId;
  name: string;
  primarySlot: SlotId;
  baseTags: string[];
  slots: SlotDef[];
  optionalSlots: SlotId[];
  dependencies: Record<SlotId, SlotId[]>;
  dropOrder: SlotId[];
  template: string;
}

export interface Culture {
  id: string;
  culture: string;
  prefixes: string[];
  suffixes: string[];
  family: string[];
}

export interface DataSet {
  version: string;
  tags: Set<string>;
  themes: Theme[];
  themeById: Record<ThemeId, Theme>;
  categories: Record<CategoryId, CategoryDef>;
  tables: Record<string, Table>;
  palettes: Palette[];
  cultures: Culture[];
}

export interface FieldValue {
  entryId: string;
  text: string;
  locked: boolean;
}

export interface BriefLine {
  label: string;
  text: string;
  slot: SlotId;
  /** Every slot the line shows; lock/reroll act on all of them. */
  slots?: SlotId[];
}

export interface Brief {
  schemaVersion: number;
  id: string;
  seed: string;
  base: string;
  index: number;
  category: CategoryId;
  theme: ThemeId;
  themeChoice: ThemeId | 'any';
  weirdness: Weirdness;
  fields: Record<SlotId, FieldValue>;
  palette: { name: string; hex: string[] };
  title: string;
  lines: BriefLine[];
  plainText: string;
  dataVersion: string;
  createdAt: number;
  rerolls: Record<SlotId, number>;
  /** Optional story built from the fields (src/engine/lore.ts). */
  lore?: {
    roll: number;
    text: string;
    /** Plot spine (Stolen, Cursed…) and the D&D hook card built on it. */
    spine?: string;
    rumour?: string;
    job?: string;
    patron?: string;
    reward?: string;
    twist?: string;
  };
  /** Saved briefs only: folder id (none = Unsorted) and when it was saved. */
  folder?: string;
  savedAt?: number;
}
