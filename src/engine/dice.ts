import { hashUnit } from './rng';
import type { CategoryDef, DataSet, Entry, SlotId } from './types';

/**
 * The d100 roll a line "came from", DMG-table style: each entry owns a slice of 1–100 sized by its base
 * weight, and the shown roll is a point inside that slice (deterministic per brief). Name slots have none.
 */
export function rollFor(data: DataSet, cat: CategoryDef, slotId: SlotId, entryId: string, seed: string): number | null {
  const slot = cat.slots.find((s) => s.id === slotId);
  if (!slot || !entryId || entryId === 'none') return null;
  let entries: { id: string; weight?: number }[];
  if (slot.kind === 'table' || slot.kind === 'event') entries = data.tables[slot.table!]?.entries ?? [];
  else if (slot.kind === 'material') entries = data.tables['shared.materials']?.entries ?? [];
  else if (slot.kind === 'palette') entries = data.palettes;
  else if (slot.kind === 'unique')
    entries = [...(data.tables['shared.unique']?.entries ?? []), ...((data.tables[slot.table!]?.entries ?? []) as Entry[])];
  else return null;
  const id = entryId.split('~')[0];
  const total = entries.reduce((n, e) => n + (e.weight ?? 5), 0);
  if (!total) return null;
  let acc = 0;
  for (const e of entries) {
    const w = e.weight ?? 5;
    if (e.id === id) {
      const lo = (acc / total) * 100;
      const hi = ((acc + w) / total) * 100;
      const r = lo + hashUnit(`${seed}-d100-${slotId}`) * (hi - lo);
      return Math.min(100, Math.max(1, Math.floor(r) + 1));
    }
    acc += w;
  }
  return null;
}
