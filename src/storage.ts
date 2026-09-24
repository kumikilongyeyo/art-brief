import { DEFAULT_STORY_INSTRUCTION } from './chat';
import type { Brief, CategoryId, ThemeId, UniqueFrequency, Weirdness } from './engine/types';
import { mergeFolders, type Folder, type LibraryFilter } from './library';

export const STORAGE_SCHEMA = 1;
export const HISTORY_LIMIT = 100;
const K = { settings: 'ab:settings', history: 'ab:history', saved: 'ab:saved', recent: 'ab:recent', folders: 'ab:folders' } as const;

export const DEFAULT_INSTRUCTION = `You are an art director writing for a fantasy concept artist.
Rewrite the art brief below into one vivid paragraph of 60–90 words.
Keep every element listed. Do not add new characters, objects or colours.
Impossible or surreal materials are intentional: describe how they
could look, do not correct or explain them away.
Then give:
- Silhouette: the shape language in one line (e.g. top-heavy, spiky, round and soft)
- Focal point: where the eye should land first
- Value plan: light, mid and dark areas, using the palette
- 3 thumbnail composition ideas, one short line each

BRIEF:
{{brief}}`;

export interface Settings {
  schemaVersion: number;
  showChatGPT: boolean;
  instruction: string;
  storyInstruction: string;
  openChatGPT: boolean;
  uniqueFrequency: UniqueFrequency;
  colorScheme: 'system' | 'light' | 'dark';
  last: { category: CategoryId; themeChoice: ThemeId | 'any'; count: number; weirdness: Weirdness; lore: boolean };
  seenSample: boolean;
  /** Which folder the Saved library is showing. */
  libraryFilter: LibraryFilter;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: STORAGE_SCHEMA,
  showChatGPT: true,
  instruction: DEFAULT_INSTRUCTION,
  storyInstruction: DEFAULT_STORY_INSTRUCTION,
  openChatGPT: false,
  uniqueFrequency: 'sometimes',
  colorScheme: 'system',
  last: { category: 'character', themeChoice: 'any', count: 2, weirdness: 'mixed', lore: false },
  seenSample: false,
  libraryFilter: 'all',
};

interface Wrapped<T> {
  schemaVersion: number;
  value: T;
}

let available: boolean | null = null;

/** True when localStorage can actually be written (false in some private modes). */
export function storageAvailable(): boolean {
  if (available !== null) return available;
  try {
    const k = 'ab:probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** For tests: forget the cached availability probe. */
export function resetStorageProbe() {
  available = null;
}

/** Migrations by from-version. v1 has none yet; add `1: (v) => ...` when the shape changes. */
const MIGRATIONS: Record<number, (v: unknown) => unknown> = {};

export function migrate<T>(raw: Wrapped<unknown>): T {
  let { schemaVersion, value } = raw;
  while (schemaVersion < STORAGE_SCHEMA) {
    const step = MIGRATIONS[schemaVersion];
    if (step) value = step(value);
    schemaVersion++;
  }
  return value as T;
}

function read<T>(key: string, fallback: T, check: (v: unknown) => boolean): T {
  try {
    const s = localStorage.getItem(key);
    if (s === null) return fallback;
    const raw = JSON.parse(s) as Wrapped<unknown>;
    if (!raw || typeof raw !== 'object' || typeof raw.schemaVersion !== 'number') throw new Error('bad shape');
    const v = migrate<T>(raw);
    if (!check(v)) throw new Error('bad value');
    return v;
  } catch {
    // Corrupt JSON or blocked storage: reset only this key and keep going.
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage blocked */
    }
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: STORAGE_SCHEMA, value }));
    return true;
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function isBrief(v: unknown): v is Brief {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.plainText === 'string' &&
    typeof v.category === 'string' &&
    isObj(v.fields) &&
    Array.isArray(v.lines)
  );
}

/** Earlier default prompts: people who never edited them get the improved ones automatically. */
const OLD_DEFAULT_INSTRUCTIONS = [
  `You are an art director writing for a fantasy concept artist.
Rewrite the art brief below into one vivid paragraph of 60–90 words.
Keep every element listed. Do not add new characters, objects or colours.
Impossible or surreal materials are intentional: describe how they
could look, do not correct or explain them away.
Then give 3 thumbnail composition ideas, one short line each.

BRIEF:
{{brief}}`,
];

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>(K.settings, {}, isObj);
  const merged = { ...DEFAULT_SETTINGS, ...s, last: { ...DEFAULT_SETTINGS.last, ...(s.last ?? {}) } };
  if (OLD_DEFAULT_INSTRUCTIONS.includes(merged.instruction)) merged.instruction = DEFAULT_INSTRUCTION;
  return merged;
}
export const saveSettings = (s: Settings) => write(K.settings, s);

export function loadHistory(): Brief[] {
  return read<Brief[]>(K.history, [], Array.isArray).filter(isBrief);
}
export function saveHistory(list: Brief[]) {
  return write(K.history, list.slice(0, HISTORY_LIMIT));
}
/** Newest first, capped at 100; an entry with the same id is replaced rather than duplicated. */
export function addToHistory(list: Brief[], briefs: Brief[]): Brief[] {
  const ids = new Set(briefs.map((b) => b.id));
  return [...briefs, ...list.filter((b) => !ids.has(b.id))].slice(0, HISTORY_LIMIT);
}

export function loadSaved(): Record<string, Brief> {
  const raw = read<Record<string, unknown>>(K.saved, {}, isObj);
  const out: Record<string, Brief> = {};
  for (const [k, v] of Object.entries(raw)) if (isBrief(v)) out[k] = v;
  return out;
}
export const saveSaved = (s: Record<string, Brief>) => write(K.saved, s);

const isFolder = (v: unknown): v is Folder => isObj(v) && typeof v.id === 'string' && typeof v.name === 'string';

export function loadFolders(): Folder[] {
  return read<unknown[]>(K.folders, [], Array.isArray).filter(isFolder);
}
export const saveFolders = (f: Folder[]) => write(K.folders, f);

export function loadRecent(): Record<string, string[]> {
  return read<Record<string, string[]>>(K.recent, {}, isObj);
}
export const saveRecent = (r: Record<string, string[]>) => write(K.recent, r);

export function clearKey(which: 'history' | 'saved') {
  try {
    localStorage.removeItem(K[which]);
  } catch {
    /* ignore */
  }
}

// ---------- export / import ----------

export function exportFileName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `art-brief-saved-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

export function exportSaved(saved: Record<string, Brief>, folders: Folder[] = []): string {
  return JSON.stringify(
    { app: 'art-brief', schemaVersion: STORAGE_SCHEMA, exportedAt: new Date().toISOString(), folders, saved: Object.values(saved) },
    null,
    2,
  );
}

/**
 * Merge an export into the library: briefs by id (never duplicated), folders by id or name.
 * Throws on files that are not Art Brief exports.
 */
export function importSaved(
  current: Record<string, Brief>,
  text: string,
  folders: Folder[] = [],
): { saved: Record<string, Brief>; folders: Folder[]; added: number } {
  const json = JSON.parse(text) as unknown;
  const list = Array.isArray(json)
    ? json
    : isObj(json) && Array.isArray(json.saved)
      ? json.saved
      : isObj(json) && isObj(json.saved)
        ? Object.values(json.saved)
        : null;
  if (!list) throw new Error('Not an Art Brief export file');
  const incoming = isObj(json) && Array.isArray(json.folders) ? (json.folders as unknown[]).filter(isFolder) : [];
  const merged = mergeFolders(folders, incoming);
  const saved = { ...current };
  let added = 0;
  for (const b of list) {
    if (!isBrief(b)) continue;
    if (!saved[b.id]) added++;
    const folder = b.folder ? merged.remap[b.folder] : undefined;
    saved[b.id] = { ...b, folder };
  }
  return { saved, folders: merged.folders, added };
}
