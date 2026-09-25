/** Reference-search vocabulary: typo repair, suggestions, mode guessing, query plans, phrase vectors. */
import type { EffMode, Mode, Plan } from './types';

export interface VocabFile {
  v: number;
  dim: number;
  keys: string[];
  cat: string; // one digit per key → cats[]
  cats: string[];
  concepts: string[];
  gate: { bad: number; ok: number };
  booru: Record<string, string[]>;
  scry: string[];
  disp?: Record<string, string>;
}

export const DIM = 512;
const BASE = `${import.meta.env.BASE_URL}refs/`;
const STOP = new Set(['a', 'an', 'the']);
const FILLER = new Set([
  'a',
  'an',
  'the',
  'of',
  'with',
  'and',
  'in',
  'on',
  'at',
  'to',
  'is',
  'some',
  'very',
  'really',
  'like',
  'that',
  'this',
  'for',
  'reference',
  'references',
  'ref',
  'refs',
  'image',
  'images',
  'picture',
  'pictures',
  'photo',
  'photos',
  'please',
  'show',
  'me',
  'find',
]);
// Typos a fast typist makes that edit distance alone gets wrong or can't reach.
const TYPO: Record<string, string> = {
  sowrd: 'sword',
  swrod: 'sword',
  sord: 'sword',
  swrd: 'sword',
  sowd: 'sword',
  holdign: 'holding',
  hodling: 'holding',
  holidng: 'holding',
  dynmaic: 'dynamic',
  dyanmic: 'dynamic',
  dinamic: 'dynamic',
  drgaon: 'dragon',
  dargon: 'dragon',
  dragn: 'dragon',
  drgon: 'dragon',
  dagon: 'dragon',
  knigth: 'knight',
  kinght: 'knight',
  knigt: 'knight',
  nite: 'knight',
  poes: 'pose',
  armour: 'armor',
  spere: 'spear',
  sheild: 'shield',
  shiled: 'shield',
  dager: 'dagger',
  helmit: 'helmet',
  wizzard: 'wizard',
  castel: 'castle',
  clif: 'cliff',
  flihgt: 'flight',
  hors: 'horse',
  stikman: 'stickman',
  stickmen: 'stickman',
  stick: 'stick',
  refernce: 'reference',
  refrence: 'reference',
  charcter: 'character',
  caracter: 'character',
  monstor: 'monster',
  warior: 'warrior',
  worrior: 'warrior',
  samuri: 'samurai',
  archr: 'archer',
  barbarain: 'barbarian',
  forrest: 'forest',
  lanturn: 'lantern',
  potoin: 'potion',
  tavren: 'tavern',
  kneelng: 'kneeling',
  silhoutte: 'silhouette',
  silouette: 'silhouette',
  howlign: 'howling',
  runing: 'running',
  jumpping: 'jumping',
};
const NOUN_CATS = new Set(['figure', 'creature', 'prop', 'place']);
const HOLD = new Set(['holding', 'carrying', 'wielding', 'with', 'swinging', 'drawing', 'raising', 'throwing', 'aiming', 'gripping']);
const SUBJECT_WORDS = new Set<string>();

export interface Vocab {
  keys: string[];
  index: Map<string, number>;
  catOf: (k: string) => string;
  tokens: Set<string>;
  shardStart: Map<string, number>;
  concepts: string[];
  gate: { bad: number; ok: number };
  booru: Record<string, string[]>;
  scry: Set<string>;
  disp: Record<string, string>;
}

let vocabP: Promise<Vocab> | null = null;
export function loadVocab(): Promise<Vocab> {
  vocabP ??= fetch(`${BASE}vocab.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`vocab ${r.status}`);
      return r.json() as Promise<VocabFile>;
    })
    .then(vocabFrom);
  vocabP.catch(() => (vocabP = null));
  return vocabP;
}

export function vocabFrom(f: VocabFile): Vocab {
  const index = new Map<string, number>();
  const shardStart = new Map<string, number>();
  const tokens = new Set<string>();
  f.keys.forEach((k, i) => {
    index.set(k, i);
    const s = shardOf(k);
    if (!shardStart.has(s)) shardStart.set(s, i);
    for (const w of k.split(' ')) tokens.add(w);
    if (f.cats[+f.cat[i]] === 'figure' && !k.includes(' ')) SUBJECT_WORDS.add(k);
  });
  return {
    keys: f.keys,
    index,
    tokens,
    shardStart,
    concepts: f.concepts,
    gate: f.gate,
    booru: f.booru,
    scry: new Set(f.scry),
    disp: f.disp ?? {},
    catOf: (k: string) => {
      const i = index.get(k);
      return i === undefined ? '' : f.cats[+f.cat[i]];
    },
  };
}

export const shardOf = (k: string) => k.split(' ')[0].replace(/[^a-z0-9-]/g, '_');
export const keyOf = (p: string) =>
  p
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
export const words = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const display = (v: Vocab, k: string) => v.disp[k] ?? k;

// ---------------------------------------------------------------- typo repair

function osa(a: string, b: string, swaps = true): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i, ...Array(b.length).fill(0)];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (swaps && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const shared = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const fixCache = new Map<string, string>();
/** Closest vocabulary word: fewest edits → swapped letters (fast typing) → longest shared start → subject nouns. */
export function fixWord(v: Vocab, w: string, partial: boolean): string {
  if (TYPO[w]) return TYPO[w];
  if (v.tokens.has(w) || FILLER.has(w)) return w;
  if (partial) for (const t of v.tokens) if (t.startsWith(w)) return w;
  if (w.length < 3 || /\d/.test(w)) return w;
  const ck = `${w}|${partial}`;
  const hit = fixCache.get(ck);
  if (hit) return hit;
  const lim = w.length <= 5 ? 1 : 2;
  let best = '',
    bs = 1e9;
  for (const t of v.tokens) {
    if (Math.abs(t.length - w.length) > lim + (partial ? 99 : 0)) continue;
    const tt = partial ? t.slice(0, w.length) : t;
    const d = osa(w, tt);
    if (d > lim) continue;
    const s = d * 10 - shared(w, t) - (NOUN_CATS.has(v.catOf(t)) ? 2 : 0) - (d < osa(w, tt, false) ? 3 : 0);
    if (s < bs) {
      bs = s;
      best = t;
    }
  }
  const out = best ? (partial ? best.slice(0, w.length) : best) : w;
  fixCache.set(ck, out);
  return out;
}
export const normWords = (v: Vocab, q: string, lastPartial: boolean) => {
  const ws = words(q);
  return ws.map((w, i) => fixWord(v, w, lastPartial && i === ws.length - 1));
};

// ---------------------------------------------------------------- suggestions

/** Vocabulary phrases that complete or contain what's typed (best first). */
export function completions(v: Vocab, raw: string, limit = 6): string[] {
  const ws = normWords(v, raw, !/\s$/.test(raw)).filter((w) => !STOP.has(w));
  if (!ws.length) return [];
  const qq = ws.join(' ');
  const starts: string[] = [],
    contains: string[] = [],
    loose: string[] = [];
  const last = ws[ws.length - 1];
  for (const k of v.keys) {
    if (k.startsWith(qq)) starts.push(k);
    else if (ws.every((w) => k.split(' ').some((t) => t.startsWith(w)))) contains.push(k);
    else if (starts.length + contains.length < limit && k.split(' ').some((t) => t.startsWith(last))) loose.push(k);
  }
  const byLen = (a: string, b: string) => a.length - b.length;
  // after "holding / carrying / with …" an object is the likely next word, not a person
  const prev = ws[ws.length - 2];
  const wantThing = !!prev && HOLD.has(prev);
  const looseScore = (k: string) =>
    k.length +
    (wantThing && (v.catOf(k) === 'prop' || v.catOf(k) === 'creature') ? -20 : 0) +
    (wantThing && v.catOf(k) === 'figure' ? 20 : 0);
  loose.sort((a, b) => looseScore(a) - looseScore(b));
  return [...starts.sort(byLen), ...contains.sort(byLen), ...loose].slice(0, limit);
}

/** What Enter searches: typos fixed; a half-typed last word takes the matching word of the top suggestion. */
export function resolveQuery(v: Vocab, raw: string): string {
  const rawWs = words(raw);
  if (!rawWs.length) return '';
  const partial = normWords(v, raw, true),
    full = normWords(v, raw, false);
  const lastRaw = rawWs[rawWs.length - 1];
  const top = completions(v, raw, 1)[0];
  if (top && lastRaw.length >= 2 && !v.tokens.has(lastRaw) && !FILLER.has(lastRaw)) {
    const last = partial[partial.length - 1];
    const cand = display(v, top)
      .replace(/,/g, '')
      .split(' ')
      .find((x) => x.startsWith(last));
    if (cand) return [...partial.slice(0, -1), cand].join(' ');
  }
  return full.join(' ');
}
export function corrected(raw: string, final: string): boolean {
  const a = words(raw),
    b = words(final);
  return a.length === b.length && a.some((w, i) => !b[i].startsWith(w));
}

// ---------------------------------------------------------------- plans

/** Longest vocabulary phrases in the text, left to right. */
export function segment(v: Vocab, text: string): string[] {
  const toks = words(text).filter((w) => !STOP.has(w));
  const out: string[] = [];
  for (let i = 0; i < toks.length;) {
    let hit = '';
    for (let n = Math.min(6, toks.length - i); n >= 1; n--) {
      const k = toks.slice(i, i + n).join(' ');
      if (v.index.has(k)) {
        hit = k;
        break;
      }
    }
    if (hit) {
      out.push(hit);
      i += hit.split(' ').length;
    } else i++;
  }
  // "man … holding sword" → also the joined phrase "man holding sword" when it exists
  const subj = out.find((k) => SUBJECT_WORDS.has(k));
  const act = out.find((k) => v.catOf(k) === 'pose' && k !== subj);
  if (subj && act && v.index.has(`${subj} ${act}`)) out.push(`${subj} ${act}`);
  return [...new Set(out)];
}

export function guessMode(v: Vocab, keys: string[]): EffMode {
  const cats = keys.map((k) => v.catOf(k));
  if (cats.includes('pose')) return 'pose';
  if (cats.includes('creature')) return 'creature';
  if (cats.includes('place')) return 'place';
  if (cats.includes('prop')) return 'prop';
  if (cats.includes('figure')) return 'pose';
  return 'concept';
}

export function makePlan(v: Vocab, text: string, mode: Mode, adult: boolean, extraKeys: string[] = []): Plan {
  const keys = [...new Set([...segment(v, text), ...extraKeys])];
  const ws = words(text).filter((w) => !FILLER.has(w));
  const eff = mode === 'auto' ? guessMode(v, keys) : mode;
  const singular = (w: string) => (w.endsWith('s') && v.tokens.has(w.slice(0, -1)) ? w.slice(0, -1) : w);
  const nouns = [
    ...new Set(
      keys
        .flatMap((k) => k.split(' '))
        .map(singular)
        .filter((w) => NOUN_CATS.has(v.catOf(w))),
    ),
  ];
  // pose tags live on sub-phrases too ("knight holding sword" → "holding sword" → holding_sword)
  const subs = (k: string) => {
    const t = k.split(' '),
      out: string[] = [];
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j <= Math.min(t.length, i + 4); j++) out.push(t.slice(i, j).join(' '));
    return out;
  };
  const booru = [
    ...new Set(
      keys
        .flatMap(subs)
        .flatMap((k) => v.booru[k] ?? [])
        .concat(ws.map(singular).flatMap((w) => v.booru[w] ?? [])),
    ),
  ];
  const scry = [...new Set(ws.map(singular).filter((w) => v.scry.has(w)))];
  return { text: text.trim(), words: ws.map(singular), keys, nouns, booru, scry, mode: eff, adult };
}

// ---------------------------------------------------------------- vectors

type Rows = { n: number; scale: Float32Array; q: Int8Array };
const shardCache = new Map<string, Promise<Rows>>();
function parseRows(buf: ArrayBuffer): Rows {
  const n = buf.byteLength / (4 + DIM);
  return { n, scale: new Float32Array(buf.slice(0, n * 4)), q: new Int8Array(buf, n * 4) };
}
function loadRows(url: string): Promise<Rows> {
  if (!shardCache.has(url)) {
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then(parseRows);
    p.catch(() => shardCache.delete(url));
    shardCache.set(url, p);
  }
  return shardCache.get(url)!;
}
const rowVec = (rows: Rows, i: number) => {
  const out = new Float32Array(DIM),
    s = rows.scale[i],
    off = i * DIM;
  for (let d = 0; d < DIM; d++) out[d] = rows.q[off + d] * s;
  return out;
};
export function normalize(a: Float32Array): Float32Array {
  let n = 0;
  for (const x of a) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < a.length; i++) a[i] /= n;
  return a;
}
export async function phraseVector(v: Vocab, k: string): Promise<Float32Array | null> {
  const i = v.index.get(k);
  if (i === undefined) return null;
  const s = shardOf(k);
  const rows = await loadRows(`${BASE}vec/${s}.bin`);
  return rowVec(rows, i - v.shardStart.get(s)!);
}

/** The query as one vector: joined subject+action phrases count most, looks and materials least. */
export async function queryVector(v: Vocab, plan: Plan): Promise<Float32Array | null> {
  if (!plan.keys.length) return null;
  const w = (k: string) => {
    const c = v.catOf(k);
    const multi = k.includes(' ') ? 1.25 : 1;
    return multi * (c === 'pose' ? 1.3 : c === 'concept' || c === 'material' ? 0.6 : 1);
  };
  const vecs = await Promise.all(plan.keys.map((k) => phraseVector(v, k).catch(() => null)));
  const out = new Float32Array(DIM);
  let any = false;
  vecs.forEach((vec, i) => {
    if (!vec) return;
    any = true;
    const wt = w(plan.keys[i]);
    for (let d = 0; d < DIM; d++) out[d] += vec[d] * wt;
  });
  return any ? normalize(out) : null;
}

let conceptP: Promise<Rows> | null = null;
/** Read an image as words: the vocabulary concepts closest to its vector, one per kind. */
export async function imageWords(v: Vocab, img: Float32Array, n = 4): Promise<string[]> {
  conceptP ??= loadRows(`${BASE}concepts.bin`);
  const rows = await conceptP;
  const scored: Array<[number, string]> = [];
  for (let i = 0; i < rows.n; i++) {
    let s = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d++) s += rows.q[off + d] * img[d];
    scored.push([s * rows.scale[i], v.concepts[i]]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out: string[] = [],
    seen = new Set<string>();
  for (const [, k] of scored) {
    const c = v.catOf(k) || 'x';
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(k);
    if (out.length >= n) break;
  }
  return out;
}

let gateP: Promise<Rows> | null = null;
/** > 0 means the image reads closer to the unsafe prompts than the safe ones. */
export async function gateScorer(v: Vocab): Promise<(e: Float32Array) => number> {
  gateP ??= loadRows(`${BASE}gate.bin`);
  const rows = await gateP;
  const vecs = Array.from({ length: rows.n }, (_, i) => rowVec(rows, i));
  const bad = vecs.slice(0, v.gate.bad),
    ok = vecs.slice(v.gate.bad);
  const dot = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let d = 0; d < DIM; d++) s += a[d] * b[d];
    return s;
  };
  return (e) => Math.max(...bad.map((b) => dot(e, b))) - Math.max(...ok.map((o) => dot(e, o)));
}
