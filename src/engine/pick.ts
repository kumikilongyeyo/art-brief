import { isBlocked, isOnTheme } from './theme';
import type { Entry, Theme, Weirdness } from './types';
import type { Rng } from './rng';

export const OFF_THEME: Record<Weirdness, number> = { grounded: 0, mixed: 0.15, wild: 0.5 };
export const SURREAL: Record<Weirdness, number> = { grounded: 0, mixed: 1, wild: 3 };
export const FUSION_CHANCE: Record<Weirdness, number> = { grounded: 0.15, mixed: 0.4, wild: 0.75 };
const WILD_BLOCK = 0.2;
const AFFINITY = 2;

export interface PickContext {
  theme: Theme;
  weirdness: Weirdness;
  /** Tags provided by the base category and everything picked so far. */
  tags: Set<string>;
  /** Tags excluded by anything picked so far. */
  excludes: Set<string>;
  /** Materials are never removed by blockTags. */
  applyBlock: boolean;
}

export interface PickResult<T extends Entry> {
  entry: T;
  /** 0 = normal; 1 = theme weighting ignored; 2 = blockTags ignored; 3 = requires ignored; 4 = full table. */
  depth: number;
}

function passesHard(e: Entry, ctx: PickContext, ignoreRequires: boolean): boolean {
  if (!ignoreRequires && e.requires?.length && !e.requires.some((r) => ctx.tags.has(r))) return false;
  if (e.excludes?.some((x) => ctx.tags.has(x))) return false;
  if (e.tags?.some((t) => ctx.excludes.has(t))) return false;
  return true;
}

export function entryWeight(e: Entry, ctx: PickContext, depth: number): number {
  let w = e.weight ?? 5;
  if (depth < 1 && !isOnTheme(e, ctx.theme)) w *= OFF_THEME[ctx.weirdness];
  if (e.surreal) w *= SURREAL[ctx.weirdness];
  if (depth < 2 && ctx.applyBlock && isBlocked(e, ctx.theme)) {
    if (ctx.weirdness !== 'wild') return 0;
    w *= WILD_BLOCK;
  }
  if (e.tags?.some((t) => ctx.tags.has(t))) w *= AFFINITY;
  return w;
}

export function weightedPick<T>(items: T[], weights: number[], rng: Rng): T | undefined {
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return undefined;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0 && weights[i] > 0) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i--) if (weights[i] > 0) return items[i];
  return undefined;
}

function pickOnce<T extends Entry>(entries: T[], ctx: PickContext, rng: Rng, avoid?: Set<string>): PickResult<T> | null {
  const pool = avoid?.size ? entries.filter((e) => !avoid.has(e.id)) : entries;
  if (!pool.length) return null;
  for (let depth = 0; depth <= 3; depth++) {
    const cand = pool.filter((e) => passesHard(e, ctx, depth >= 3));
    const weights = cand.map((e) => entryWeight(e, ctx, depth));
    const picked = weightedPick(cand, weights, rng);
    if (picked) return { entry: picked, depth };
  }
  const weights = pool.map((e) => e.weight ?? 5);
  const picked = weightedPick(pool, weights, rng);
  return picked ? { entry: picked, depth: 4 } : null;
}

/**
 * Filter + weighted pick with the fallback chain from spec 5.7. `avoid` ids are dropped first
 * (batch palette de-dupe, trait groups); if that forces a deeper fallback, the avoid list is waived.
 */
export function pickEntry<T extends Entry>(entries: T[], ctx: PickContext, rng: Rng, avoid?: Set<string>): PickResult<T> {
  if (!entries.length) throw new Error('pickEntry: empty table');
  const first = pickOnce(entries, ctx, rng, avoid);
  if (first && first.depth === 0) return first;
  if (avoid?.size) {
    const second = pickOnce(entries, ctx, rng);
    if (second && (!first || second.depth < first.depth)) return second;
  }
  return first ?? pickOnce(entries, ctx, rng)!;
}
