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
  real?: string[]; // everyday words that aren't typos, though they're a letter or two from a vocabulary word
}

export const DIM = 512;
declare const __REFS_V__: string;
const BASE = `${import.meta.env.BASE_URL}refs/`;
/** Every data URL carries the build's data fingerprint (see vite.config.ts), so caches never mix versions. */
export const V = `?v=${__REFS_V__}`;
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
// Real words artists type that the vocabulary and its common-word list lack, each an edit or two from
// one they have ("chin" isn't "chain", "stab" isn't "stag", "fang" isn't "fantasy"): searched as typed.
const KNOWN = new Set(
  (
    'fang hoof hooves paw sash veil brow chin buckle stork spire squat stoop stab soar beard coif torc ' +
    'maul cane spade hoe bellows urn mare rooster butte grin yell gasp mane glade attic wisp'
  ).split(' '),
);
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
  real: Set<string>;
}

let vocabP: Promise<Vocab> | null = null;
export function loadVocab(): Promise<Vocab> {
  vocabP ??= fetch(`${BASE}vocab.json${V}`)
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
    real: new Set(f.real ?? []),
    catOf: (k: string) => {
      const i = index.get(k);
      return i === undefined ? '' : f.cats[+f.cat[i]];
    },
  };
}

export const shardOf = (k: string) => k.split(' ')[0].slice(0, 3).replace(/[^a-z0-9-]/g, '_'); // same as build-vocab.mjs
/** Lower case with accents folded ("pokémon" → "pokemon"). Letters of other scripts are kept ("дракон",
 *  "ドラゴン" are words); symbols and emoji become spaces. */
const plain = (q: string) =>
  q
    .toLowerCase()
    .normalize('NFD')
    .replace(/([a-z])[\u0300-\u036f]+/g, '$1')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}' -]/gu, ' ')
    .replace(/(^|\s)\p{M}+/gu, '$1'); // marks left on nothing (an emoji's variation selector)
export const keyOf = (p: string) =>
  plain(p)
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
export const words = (q: string) =>
  plain(q)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const display = (v: Vocab, k: string) => v.disp[k] ?? k;

// ---------------------------------------------------------------- typo repair

// A slip of the finger hits a key next to the right one; a letter from across the keyboard makes a
// different word ("rearing" isn't "roaring", "fangs" isn't "fans"), so it costs two edits.
// Letters that sound alike are misspelt for each other the same way ("skeliton", "wizerd", "dragen").
const NEAR = new Uint8Array(26 * 26); // NEAR[a * 26 + b]: keys a and b touch (or are the same key), or sound alike
{
  const at: Array<[number, number]> = [];
  ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].forEach((r, y) => [...r].forEach((c, x) => (at[c.charCodeAt(0) - 97] = [x + y / 2, y])));
  at.forEach((p, a) => at.forEach((q, b) => (NEAR[a * 26 + b] = Number(Math.abs(p[0] - q[0]) <= 1 && Math.abs(p[1] - q[1]) <= 1))));
  for (const g of ['aeiouy', 'cks', 'sz', 'gj'])
    for (const a of g) for (const b of g) NEAR[(a.charCodeAt(0) - 97) * 26 + b.charCodeAt(0) - 97] = 1;
}
const near = (a: string, b: string | undefined) => {
  const i = a.charCodeAt(0) - 97,
    j = b === undefined ? -1 : b.charCodeAt(0) - 97;
  return i >= 0 && i < 26 && j >= 0 && j < 26 && NEAR[i * 26 + j] === 1;
};
/** Edits from the typed word `a` to `b`: a missing letter or swapped pair costs 1; a wrong or extra key
 *  costs 1 next to where it belongs (a doubled key is next to itself), 2 anywhere else. */
function osa(a: string, b: string, swaps = true): number {
  const d: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  const extra = (i: number) => (near(a[i - 1], a[i - 2]) || near(a[i - 1], a[i]) ? 1 : 2); // a[i - 1] typed by mistake
  for (let i = 1; i <= a.length; i++) d[i] = [d[i - 1][0] + extra(i), ...Array(b.length).fill(0)];
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + extra(i), d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : near(a[i - 1], b[j - 1]) ? 1 : 2));
      if (swaps && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const shared = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const doubled = (w: string, t: string) => w.length === t.length + 1 && [...w].some((c, i) => c === w[i - 1] && w.slice(0, i) + w.slice(i + 1) === t);
/** A regular form of a word it knows is a real word, not a typo: "rearing" (rear), "flowing" (flow),
 *  "scaled" (scale), "foggy" (fog), "robes". */
function inflected(v: Vocab, w: string): boolean {
  const known = (s: string) => s.length >= 3 && (v.tokens.has(s) || v.tokens.has(`${s}s`) || KNOWN.has(s));
  const stem = (suf: string) => (w.endsWith(suf) ? w.slice(0, -suf.length) : '');
  const cvc = (s: string) => /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(s); // one vowel, one consonant: swim, fog, stop
  const s = stem('s');
  // a word ending in s takes -es, not another s ("bootss" is a typo)
  if ((!s.endsWith('s') && known(s)) || known(stem('ly')) || known(`${stem('ies') || stem('ied')}y`)) return true;
  // -ing, -ed, -er, -y…: also after a dropped e (glide → gliding); only a word ending in one vowel and a
  // consonant doubles it (swim → swimming, fog → foggy), so "swiming" and "fightting" are still typos
  return ['ing', 'ed', 'er', 'est', 'es', 'y'].some((suf) => {
    const st = stem(suf),
      one = st.slice(0, -1);
    if (!st || (suf === 'y' && st.endsWith('y'))) return false;
    return known(`${st}e`) || (st.at(-1) === st.at(-2) && cvc(one) && known(one)) || (known(st) && /[^aeiou]$/.test(st) && !cvc(st));
  });
}
const fixCache = new Map<string, string>();
/** Closest vocabulary word: fewest edits → swapped letters (fast typing) → longest shared start → subject nouns. */
/** Closest vocabulary word, only when confident — a word it doesn't know is otherwise left alone
 *  ("totoro" stays "totoro"). One edit is enough for words of 4+ letters; two edits only for 7+ letters
 *  that start the same. The first letter must match unless the typo swapped the first two letters.
 *  Ties: swapped letters (fast typing) → longest shared start → subject nouns. */
export function fixWord(v: Vocab, w: string, partial: boolean): string {
  if (TYPO[w]) return TYPO[w];
  if (v.tokens.has(w) || FILLER.has(w) || KNOWN.has(w) || v.real.has(w)) return w; // "thorn" isn't a slip of "throne"
  if (partial) for (const t of v.tokens) if (t.startsWith(w)) return w;
  if (w.length < (partial ? 3 : 4) || /[^a-z'-]/.test(w) || inflected(v, w)) return w; // numbers and other scripts too
  const ck = `${w}|${partial}`;
  const hit = fixCache.get(ck);
  if (hit) return hit;
  let best = '',
    bs = 1e9;
  for (const t of v.tokens) {
    if (!partial && Math.abs(t.length - w.length) > 2) continue;
    if (partial && t.length < w.length) continue;
    // the first letter must be right, or swapped with the second (checked first: it's cheap)
    if (w[0] !== t[0] && !(w[0] === t[1] && w[1] === t[0])) continue;
    const tt = partial ? t.slice(0, w.length) : t;
    const d = osa(w, tt);
    const lim = partial ? 1 : w.length >= 7 && w.slice(0, 2) === t.slice(0, 2) ? 2 : 1;
    if (d > lim) continue;
    const swapped = d < osa(w, tt, false);
    if (w[0] !== t[0] && !swapped) continue;
    // plain English words only fix obvious slips, a swapped pair or a doubled letter typed once or twice:
    // one letter more, less or different is often another real word ("fangs" isn't "fans", "geralt" is a
    // name, not "gerald")
    if (v.catOf(t) === 'common' && !partial && !(swapped && d === 1) && !doubled(w, t) && !doubled(t, w)) continue;
    const s = d * 10 - shared(w, t) - (NOUN_CATS.has(v.catOf(t)) ? 2 : 0) - (swapped ? 3 : 0);
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
    if (v.catOf(k) === 'common') continue; // plain English words help matching, not suggestions
    if (k.startsWith(qq)) starts.push(k);
    else if (ws.every((w) => k.split(' ').some((t) => t.startsWith(w)))) contains.push(k);
    else if (starts.length + contains.length < limit && k.split(' ').some((t) => t.startsWith(last))) loose.push(k);
  }
  if (!starts.length && !contains.length && ws.length > 3) {
    // a long query: suggest completions of its last few words, keeping the start as typed
    const head = ws.slice(0, -3).join(' '), tail = completions(v, ws.slice(-3).join(' ') + (/\s$/.test(raw) ? ' ' : ''), limit);
    return tail.map((k) => `${head} ${k}`);
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
  // a whole word that clearly fixes to a known word wins over completing it into a longer one
  const fixedLast = full[full.length - 1];
  if (fixedLast !== lastRaw && v.tokens.has(fixedLast)) return full.join(' ');
  const top = completions(v, raw, 1)[0];
  if (top && lastRaw.length >= 2 && !v.tokens.has(lastRaw) && !FILLER.has(lastRaw) && !KNOWN.has(lastRaw)) {
    const last = partial[partial.length - 1];
    const cand = display(v, top)
      .replace(/,/g, '')
      .split(' ')
      .find((x) => x.startsWith(last));
    // a short word that only nearly starts one is more likely finished than mistyped ("mop" isn't "moose"),
    // unless two keys came out swapped ("holding sow" → sword)
    const head = cand?.slice(0, lastRaw.length) ?? '';
    if (cand && (cand.startsWith(lastRaw) || lastRaw.length >= 5 || osa(lastRaw, head) < osa(lastRaw, head, false)))
      return [...partial.slice(0, -1), cand].join(' ');
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
  // a plural finds its word too ("flowing robes" → robe, "wolfs howling" → wolf howling)
  const one = toks.map((w) => {
    for (const [end, add] of [['s', ''], ['es', ''], ['ies', 'y']]) if (w.endsWith(end) && v.tokens.has(w.slice(0, -end.length) + add)) return w.slice(0, -end.length) + add;
    return w;
  });
  const out: string[] = [];
  for (let i = 0; i < toks.length;) {
    let hit = '';
    for (let n = Math.min(6, toks.length - i); n >= 1; n--) {
      const k = [toks, one].map((t) => t.slice(i, i + n).join(' ')).find((x) => v.index.has(x));
      if (k) {
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
  const rows = await loadRows(`${BASE}vec/${s}.bin${V}`);
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
/** The words a picture reads as, best first, one per kind of word (subject, place, prop, style…), with
 *  how strongly it reads as each. */
export async function imageTerms(v: Vocab, img: Float32Array, n = 4): Promise<Array<[string, number]>> {
  conceptP ??= loadRows(`${BASE}concepts.bin${V}`);
  const rows = await conceptP;
  const scored: Array<[number, string]> = [];
  for (let i = 0; i < rows.n; i++) {
    let s = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d++) s += rows.q[off + d] * img[d];
    scored.push([s * rows.scale[i], v.concepts[i]]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out: Array<[string, number]> = [],
    seen = new Set<string>();
  for (const [sc, k] of scored) {
    const c = v.catOf(k) || 'x';
    if (seen.has(c)) continue;
    seen.add(c);
    out.push([k, sc]);
    if (out.length >= n) break;
  }
  return out;
}
export async function imageWords(v: Vocab, img: Float32Array, n = 4): Promise<string[]> {
  return (await imageTerms(v, img, n)).map(([w]) => w);
}

/** What to ask title-searching sources about a picture: what it's of, in a word or two ("palace", not
 *  "palace three-quarter view airship golem"). View, lighting, pose and material words describe how it's
 *  drawn, and each extra word makes most sites find less. A second subject only when it reads nearly as
 *  strongly as the first. */
export function subjectQuery(v: Vocab, terms: Array<[string, number]>): string {
  const subj = terms.filter(([w]) => !['pose', 'concept', 'material'].includes(v.catOf(w)));
  if (!subj.length) return terms[0]?.[0] ?? '';
  const [a, b] = subj;
  return b && b[1] > a[1] - 0.004 ? `${a[0]} ${b[0]}` : a[0];
}

/** Words read from a line drawing searched by how it looks (not as a pose). Its pose and lighting/view words
 *  describe the drawing ("stick figure", "three-quarter view"), not what it's of; and the kind of thing the
 *  mode asks for goes first (a house drawn in Place mode is a "cottage" before it's a "trap"). */
export function drawingWords(v: Vocab, words: string[], mode: Mode): string[] {
  const kept = words.filter((w) => v.catOf(w) !== 'pose' && v.catOf(w) !== 'concept');
  const i = mode === 'place' || mode === 'prop' || mode === 'creature' ? kept.findIndex((w) => v.catOf(w) === mode) : -1;
  return i > 0 ? [kept[i], ...kept.slice(0, i), ...kept.slice(i + 1)] : kept;
}

let gateP: Promise<Rows> | null = null;
/** > 0 means the image reads closer to the unsafe prompts than the safe ones. */
export async function gateScorer(v: Vocab): Promise<(e: Float32Array) => number> {
  gateP ??= loadRows(`${BASE}gate.bin${V}`);
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
