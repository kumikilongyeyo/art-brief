import { loadData } from '../../src/data';
import { generateBatch, type BatchOptions } from '../../src/engine/generate';
import { seedFromString } from '../../src/engine/rng';
import type { Brief, CategoryId } from '../../src/engine/types';

export const data = loadData();
export const CATS: CategoryId[] = ['character', 'prop', 'creature', 'building', 'scene'];

export function seeds(n: number, salt = 's'): string[] {
  return Array.from({ length: n }, (_, i) => seedFromString(`${salt}-${i}`));
}

export function one(category: CategoryId, base: string, over: Partial<BatchOptions> = {}): Brief {
  return generateBatch(data, {
    category,
    themeChoice: 'any',
    weirdness: 'mixed',
    count: 1,
    base,
    uniqueFrequency: 'sometimes',
    ...over,
  })[0];
}
