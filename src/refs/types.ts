import type { Skeleton } from './pose';

export type Mode = 'auto' | 'pose' | 'concept' | 'place' | 'prop' | 'creature';
export type EffMode = Exclude<Mode, 'auto'>;

export type SourceId =
  | 'artstation'
  | 'wallhaven'
  | 'safebooru'
  | 'openverse'
  | 'commons'
  | 'inat'
  | 'met'
  | 'cleveland'
  | 'artsmia'
  | 'europeana'
  | 'scryfall'
  | 'riftbound'
  | 'lol'
  | 'hearthstone'
  | 'ygo'
  | 'lorcana'
  | 'swu'
  | 'dnd'
  | 'poses'
  | 'forgottenrealms'
  | 'criticalrole'
  | 'pathfinder'
  | 'warhammer'
  | 'elderscrolls'
  | 'uesp'
  | 'mtgwiki'
  | 'lolwiki';

/** One image a source returned. */
export interface Cand {
  key: string; // source:id — unique
  src: SourceId;
  title: string;
  thumb: string; // shown in the grid
  rankThumb?: string; // a smaller image for the ranking model, when the source has one
  full: string; // shown in the viewer
  page: string; // "Open on …"
  artist?: string;
  tags: string[]; // lowercase words the source attached
  aspect?: number; // width / height
  adult?: boolean; // the source itself flagged it
  pos: number; // position in that source's own results (0 = its best)
  /** Pre-analysed catalogs hand over the image's vector (and pose match) so it needs no ranking fetch. */
  vec?: Float32Array;
  poseScore?: number;
  figure?: boolean; // the index knows whether a person is in it
}

/** What the engine understood from the words, handed to every source. */
export interface Plan {
  text: string; // corrected text as shown to the user
  words: string[]; // content words (no stop words)
  keys: string[]; // vocabulary phrases found in the text
  nouns: string[]; // concrete things (for museums, card names…)
  booru: string[]; // Safebooru tags
  scry: string[]; // Scryfall art: tags
  mode: EffMode;
  adult: boolean;
}

/** What the engine knows that sources may use: the query as a vector, and the pose to match. */
export interface SearchCtx {
  q: Float32Array | null;
  pose?: Skeleton;
  memo: Map<string, unknown>; // per-search scratch space (e.g. a catalog's ranked rows)
}

export interface Page {
  items: Cand[];
  more: boolean; // another page exists
}

export interface Source {
  id: SourceId;
  label: string;
  /** How much this source is worth in each mode (0 = don't ask it). */
  trust: Record<EffMode, number>;
  /** The thumbnail can be read by the ranking model directly (it sends CORS headers and is small). */
  corsThumb?: boolean;
  /** Answers from files shipped with the app (instant): capped per batch so it can't crowd out the web. */
  local?: boolean;
  /** Only publisher-approved art (official card and game art): the adult check is skipped. */
  sfw?: boolean;
  search(plan: Plan, page: number, signal: AbortSignal, ctx: SearchCtx): Promise<Page>;
}
