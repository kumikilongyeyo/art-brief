import { pickEntry, type PickContext } from './pick';
import type { Rng } from './rng';
import type { CategoryId, Culture, DataSet, Entry } from './types';

export interface NameSources {
  /** Tags of the entries that feed the name (species / origin) — used to find a culture. */
  cultureTags: string[];
  /** Title-case noun label from the primary entry (e.g. "Crown", "Wader", "Library", "Market"). */
  label: string;
  /** Tags of the entry the label came from (building function → forge, library…). */
  labelTags?: string[];
}

function cultureFor(data: DataSet, tags: string[], rng: Rng): Culture {
  const tag = tags.find((t) => t.startsWith('culture-'));
  const found = tag ? data.cultures.find((c) => c.culture === tag) : undefined;
  if (found) return found;
  return data.cultures[Math.floor(rng() * data.cultures.length)];
}

function pickStr(list: string[], rng: Rng): string {
  return list[Math.floor(rng() * list.length)];
}

/** Join prefix + suffix without tripled letters or awkward apostrophe doubles. */
export function joinParts(a: string, b: string): string {
  if (!b) return a;
  const last = a.slice(-1).toLowerCase();
  if (a.slice(-2).toLowerCase() === last + last && b[0] === last) b = b.slice(1);
  if (last === b[0] && /[aeiouy']/.test(last)) b = b.slice(1);
  if (a.endsWith("'") && b.startsWith("'")) b = b.slice(1);
  return a + b;
}

export function givenName(c: Culture, rng: Rng): string {
  return joinParts(pickStr(c.prefixes, rng), pickStr(c.suffixes, rng));
}

function word(data: DataSet, table: string, ctx: PickContext, rng: Rng): string {
  const entries = (data.tables[table]?.entries ?? []) as Entry[];
  if (!entries.length) return '';
  return pickEntry(entries, ctx, rng).entry.text;
}

export function buildName(category: CategoryId, data: DataSet, src: NameSources, ctx: PickContext, rng: Rng): string {
  switch (category) {
    case 'character': {
      const c = cultureFor(data, src.cultureTags, rng);
      const given = givenName(c, rng);
      return rng() < 0.6 ? `${given} ${pickStr(c.family, rng)}` : given;
    }
    case 'prop': {
      if (rng() < 0.55) return `The ${word(data, 'shared.item-adjective', ctx, rng)} ${src.label}`;
      const c = cultureFor(data, src.cultureTags, rng);
      return `${givenName(c, rng)}'s ${src.label}`;
    }
    case 'creature': {
      const first = word(data, 'shared.creature-first', ctx, rng);
      const second = word(data, 'shared.creature-second', ctx, rng).toLowerCase();
      return `${joinParts(first, second)} ${src.label}`;
    }
    case 'building': {
      // Epithets tagged like the building's function get a strong pull ("Forge of the Cold Anvil").
      if (rng() < 0.6) {
        const own = { ...ctx, tags: new Set(src.labelTags ?? []), excludes: new Set<string>(), affinity: 5 };
        return `${src.label} of the ${word(data, 'shared.building-epithet', own, rng)}`;
      }
      return `The ${word(data, 'shared.item-adjective', ctx, rng)} ${src.label}`;
    }
    case 'scene':
      return `The ${word(data, 'shared.scene-word', ctx, rng)} ${src.label}`;
  }
}
