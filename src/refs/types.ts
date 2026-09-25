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
  | 'smithsonian'
  | 'europeana'
  | 'scryfall'
  | 'riftbound'
  | 'lol'
  | 'hearthstone'
  | 'ygo'
  | 'lorcana'
  | 'swu'
  | 'dnd'
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

export interface Page {
  items: Cand[];
  more: boolean; // another page exists
}

export interface Source {
  id: SourceId;
  label: string;
  /** How much this source is worth in each mode (0 = don't ask it). */
  trust: Record<EffMode, number>;
  /** The thumbnail can be read by the ranking model directly (CORS allowed). */
  corsThumb?: boolean;
  search(plan: Plan, page: number, signal: AbortSignal): Promise<Page>;
}
