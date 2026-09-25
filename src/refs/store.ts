/** Saved references and reference-search preferences, in localStorage beside the briefs.
 *  Only links and titles are kept (about 1 KB each) — never the images themselves. */
import type { Cand, SourceId } from './types';

export interface SavedRef {
  key: string;
  src: SourceId;
  title: string;
  thumb: string;
  full: string;
  page: string;
  artist?: string;
  aspect?: number;
  folder?: string; // shared with the briefs' folders
  savedAt: number;
}
export interface RefPrefs {
  adult: boolean;
  mirror: boolean;
  off: SourceId[]; // sources the user switched off
}

const K_SAVED = 'ab:refs-saved';
const K_PREFS = 'ab:refs-prefs';

function read<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as { v?: number; value?: T };
    return v && typeof v === 'object' && 'value' in v ? (v.value as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(k: string, value: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify({ v: 1, value }));
    return true;
  } catch {
    return false; // private mode or full: the page keeps working, nothing is persisted
  }
}

export function loadRefs(): Record<string, SavedRef> {
  const v = read<Record<string, SavedRef>>(K_SAVED, {});
  const out: Record<string, SavedRef> = {};
  for (const [k, r] of Object.entries(v ?? {})) if (r && typeof r.thumb === 'string' && typeof r.page === 'string') out[k] = r;
  return out;
}
export const saveRefs = (all: Record<string, SavedRef>) => write(K_SAVED, all);

export function refFrom(c: Cand, folder: string | undefined, now = Date.now()): SavedRef {
  return {
    key: c.key,
    src: c.src,
    title: c.title,
    thumb: c.thumb,
    full: c.full,
    page: c.page,
    artist: c.artist,
    aspect: c.aspect,
    folder,
    savedAt: now,
  };
}

export function loadPrefs(): RefPrefs {
  const p = read<Partial<RefPrefs>>(K_PREFS, {});
  return { adult: !!p.adult, mirror: p.mirror !== false, off: Array.isArray(p.off) ? p.off : [] };
}
export const savePrefs = (p: RefPrefs) => write(K_PREFS, p);
