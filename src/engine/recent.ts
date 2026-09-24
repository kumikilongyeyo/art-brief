import { generateBatch, type BatchOptions } from './generate';
import { hashUnit, seedFromString } from './rng';
import type { Brief, DataSet } from './types';

export const RECENT_LIMIT = 30;
const RECENT_FACTOR = 0.25;
const ATTEMPTS = 12;

/**
 * Anti-repetition (spec 5.4) without breaking reproducible links: instead of changing weights
 * (which would make a batch depend on local history), try candidate base seeds and accept one whose
 * primary picks were recently seen with probability 0.25 per repeat. Each candidate is pure, so any
 * accepted batch is exactly reproducible from its seed alone.
 */
export function chooseFreshBatch(
  data: DataSet,
  opts: Omit<BatchOptions, 'base'>,
  entropy: string,
  recentPrimary: string[],
): { base: string; briefs: Brief[] } {
  const recent = new Set(recentPrimary);
  const primary = data.categories[opts.category].primarySlot;
  let best: { base: string; briefs: Brief[]; repeats: number } | null = null;
  for (let a = 0; a < ATTEMPTS; a++) {
    const base = seedFromString(`${entropy}-${a}`);
    const briefs = generateBatch(data, { ...opts, base });
    const repeats = briefs.filter((b) => recent.has(b.fields[primary].entryId)).length;
    if (repeats === 0 || hashUnit(`${base}-accept`) < Math.pow(RECENT_FACTOR, repeats)) return { base, briefs };
    if (!best || repeats < best.repeats) best = { base, briefs, repeats };
  }
  return { base: best!.base, briefs: best!.briefs };
}

export function pushRecent(list: string[], ids: string[]): string[] {
  const next = [...ids, ...list.filter((x) => !ids.includes(x))];
  return next.slice(0, RECENT_LIMIT);
}
