import { isBaseSeed } from './engine/rng';
import {
  CATEGORY_IDS,
  WEIRDNESS,
  type CategoryId,
  type DataSet,
  type SlotId,
  type ThemeId,
  type UniqueFrequency,
  type Weirdness,
} from './engine/types';

export interface ShareState {
  category: CategoryId;
  themeChoice: ThemeId | 'any';
  weirdness: Weirdness;
  count: number;
  base: string;
  version: string | null;
  uniqueFrequency: UniqueFrequency;
  /** Single-card links: variation index and every field value; `locked` lists the locked slots. */
  index?: number;
  seed?: string;
  fields?: Record<SlotId, string>;
  locked?: Record<SlotId, string>;
  /** Story shown, with this telling (roll). */
  lore?: number;
  /** Which take on the art direction. */
  art?: number;
  /** Studio job id. */
  job?: string;
}

const FREQ: UniqueFrequency[] = ['never', 'sometimes', 'often'];
const SLOT_RE = /^[a-zA-Z]{1,20}$/;
const SEED_VARIANT_RE = /^[0-9A-HJKMNP-TV-Z]{6}-[0-3](-r\d{1,2})?$/;

function encodePairs(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}:${encodeURIComponent(v)}`)
    .join(',');
}

function decodePairs(s: string | null, validSlots: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(',').slice(0, 30)) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const k = part.slice(0, i);
    let v: string;
    try {
      v = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    if (!SLOT_RE.test(k) || !validSlots.has(k) || !v || v.length > 200) continue;
    out[k] = v;
  }
  return out;
}

export function encodeShare(s: ShareState): string {
  const p: string[] = [`c=${s.category}`, `t=${s.themeChoice}`, `w=${s.weirdness}`, `n=${s.count}`, `s=${s.base}`];
  if (s.version) p.push(`v=${encodeURIComponent(s.version)}`);
  if (s.uniqueFrequency !== 'sometimes') p.push(`u=${s.uniqueFrequency}`);
  if (s.index !== undefined) p.push(`i=${s.index}`);
  if (s.seed && s.seed !== `${s.base}-${s.index ?? 0}`) p.push(`r=${encodeURIComponent(s.seed)}`);
  if (s.fields && Object.keys(s.fields).length) p.push(`f=${encodePairs(s.fields)}`);
  if (s.locked && Object.keys(s.locked).length) p.push(`l=${encodePairs(s.locked)}`);
  if (s.lore !== undefined) p.push(`lo=${s.lore}`);
  if (s.art) p.push(`ar=${s.art}`);
  if (s.job && s.job !== 'any') p.push(`j=${encodeURIComponent(s.job)}`);
  return `#${p.join('&')}`;
}

/** Parse a location hash. Anything invalid falls back to a default; never throws. Returns null if no seed. */
export function decodeShare(hash: string, data: DataSet): ShareState | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash.replace(/^#/, ''));
  } catch {
    return null;
  }
  const base = (params.get('s') ?? '').toUpperCase();
  if (!isBaseSeed(base)) return null;
  const c = params.get('c') as CategoryId;
  const category = CATEGORY_IDS.includes(c) ? c : 'character';
  const t = params.get('t') ?? 'any';
  const themeChoice = t === 'any' || data.themeById[t] ? t : 'any';
  const w = params.get('w') as Weirdness;
  const weirdness = WEIRDNESS.includes(w) ? w : 'mixed';
  const nRaw = parseInt(params.get('n') ?? '', 10);
  const count = Number.isFinite(nRaw) ? Math.min(4, Math.max(1, nRaw)) : 2;
  const u = params.get('u') as UniqueFrequency;
  const uniqueFrequency = FREQ.includes(u) ? u : 'sometimes';
  const v = params.get('v');
  const version = v && /^[\w.-]{1,20}$/.test(v) ? v : null;
  const slots = new Set(data.categories[category].slots.map((x) => x.id));
  const state: ShareState = { category, themeChoice, weirdness, count, base, version, uniqueFrequency };
  const iRaw = parseInt(params.get('i') ?? '', 10);
  if (Number.isFinite(iRaw) && iRaw >= 0 && iRaw <= 3) {
    state.index = iRaw;
    const r = params.get('r');
    state.seed = r && SEED_VARIANT_RE.test(r) && r.startsWith(`${base}-${iRaw}`) ? r : `${base}-${iRaw}`;
  }
  const fields = decodePairs(params.get('f'), slots);
  const locked = decodePairs(params.get('l'), slots);
  const lo = parseInt(params.get('lo') ?? '', 10);
  if (Number.isFinite(lo) && lo >= 0 && lo < 10000) state.lore = lo;
  const j = params.get('j');
  if (j && (data.tables['shared.art-purpose']?.entries ?? []).some((e) => e.id === j)) state.job = j;
  const ar = parseInt(params.get('ar') ?? '', 10);
  if (Number.isFinite(ar) && ar > 0 && ar < 10000) state.art = ar;
  if (Object.keys(fields).length) state.fields = fields;
  if (Object.keys(locked).length) state.locked = locked;
  return state;
}
