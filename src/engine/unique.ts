import type { Tier, UniqueFrequency, Weirdness } from './types';
import type { Rng } from './rng';

export type TierRoll = Tier | 'none';
export const TIERS: TierRoll[] = ['none', 'minor', 'notable', 'legendary'];

const BASE: Record<TierRoll, number> = { none: 0.45, minor: 0.35, notable: 0.15, legendary: 0.05 };

/**
 * Tier probabilities (spec 5.5). "Often" halves None and redistributes proportionally;
 * weirdness then moves chance out of None: Mixed +5% notable, Wild +5% notable and +5% legendary.
 * "Never" always yields None.
 */
export function tierOdds(freq: UniqueFrequency, weirdness: Weirdness): Record<TierRoll, number> {
  if (freq === 'never') return { none: 1, minor: 0, notable: 0, legendary: 0 };
  const o = { ...BASE };
  if (freq === 'often') {
    const none = o.none / 2;
    const scale = (1 - none) / (1 - o.none);
    o.minor *= scale;
    o.notable *= scale;
    o.legendary *= scale;
    o.none = none;
  }
  if (weirdness === 'mixed') {
    o.notable += 0.05;
    o.none -= 0.05;
  } else if (weirdness === 'wild') {
    o.notable += 0.05;
    o.legendary += 0.05;
    o.none -= 0.1;
  }
  return o;
}

export function rollTier(freq: UniqueFrequency, weirdness: Weirdness, rng: Rng): TierRoll {
  const odds = tierOdds(freq, weirdness);
  let r = rng();
  for (const t of TIERS) {
    r -= odds[t];
    if (r < 0) return t;
  }
  return 'none';
}
