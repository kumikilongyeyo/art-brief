import type { CategoryId, DataSet } from './types';

/** Product of pool sizes for the non-optional slots (theme Any, Mixed: every entry is reachable). */
export function countCombinations(data: DataSet, category: CategoryId): number {
  const cat = data.categories[category];
  let total = 1;
  for (const slot of cat.slots) {
    if (cat.optionalSlots.includes(slot.id) || slot.kind === 'name' || slot.kind === 'unique') continue;
    let n: number;
    if (slot.kind === 'material') n = data.tables['shared.materials']?.entries.length ?? 0;
    else if (slot.kind === 'palette') n = data.palettes.length;
    else if (slot.kind === 'event') n = (data.tables[slot.table!]?.entries.length ?? 0) * (data.tables[slot.actors!]?.entries.length ?? 0);
    else {
      const size = data.tables[slot.table!]?.entries.length ?? 0;
      const k = slot.count ?? 1;
      n = k === 2 ? (size * (size - 1)) / 2 : size;
    }
    // Subclasses are tied to one class each: count them as "per class" (39 / 13 = 3).
    if (slot.id === 'subclass') {
      const classes = data.tables['character.class']?.entries.length || 1;
      n = n / classes;
    }
    total *= Math.max(1, n);
  }
  return total;
}

const UNITS: [number, string][] = [
  [1e18, 'quintillion'],
  [1e15, 'quadrillion'],
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
];

export function formatCount(n: number): string {
  for (const [v, name] of UNITS) {
    if (n >= v) {
      const x = n / v;
      return `~${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')} ${name}`;
    }
  }
  return `~${Math.round(n).toLocaleString('en-US')}`;
}
