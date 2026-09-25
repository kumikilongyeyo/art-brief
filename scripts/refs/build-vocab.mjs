// Builds the reference-search vocabulary: phrase list (suggestions, typo repair, query parsing),
// per-phrase MobileCLIP-S0 text vectors (ranking), and a concept set for reading images.
//
//   node scripts/refs/build-vocab.mjs
//
// Output (public/refs/):
//   vocab.json         { v, keys[], cat[], booru{}, scry[] }  — key = phrase without a/an/the
//   vec/<shard>.bin    rows for every key whose first word is <shard>: [n × f32 scale][n × 512 × i8]
//   concepts.bin       the same row format for CONCEPTS (image → words), order = vocab.json concepts[]
//   gate.bin           rows for the adult/relevance gate prompts, order = vocab.json gate[]
import fs from 'node:fs';
import path from 'node:path';
import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers';
import * as L from './vocab-lists.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const OUT = path.join(ROOT, 'public/refs');
env.cacheDir = path.join(ROOT, '.cache/hf/');
const DIM = 512;

const STOP = new Set(['a', 'an', 'the']);
export const keyOf = (p) =>
  p
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');

// ---- phrases, each with a category (drives mode guessing) ----
const cat = new Map();
const disp = new Map(); // key → natural wording, only when they differ ("castle on cliff" → "castle on a cliff")
const add = (p, c) => {
  const k = keyOf(p);
  if (k && !cat.has(k)) {
    cat.set(k, c);
    const nice = p.toLowerCase().replace(/\s+/g, ' ').trim();
    if (nice !== k) disp.set(k, nice);
  }
};
L.POSE_WORDS.forEach((p) => add(p, 'pose'));
L.ACTIONS.forEach((p) => add(p, 'pose'));
L.SUBJECTS.forEach((p) => add(p, 'figure'));
for (const s of L.SUBJECTS) for (const a of L.ACTIONS) add(`${s} ${a}`, 'pose');
L.CREATURES.forEach((p) => add(p, 'creature'));
for (const c of L.CREATURES.slice(0, 60))
  for (const a of [
    'flying',
    'roaring',
    'sleeping',
    'attacking',
    'running',
    'perched on a cliff',
    'in flight',
    'breathing fire',
    'howling',
    'hunting',
    'swimming',
    'close-up',
    'side view',
    'skull',
    'skeleton',
  ])
    add(`${c} ${a}`, 'creature');
L.PROPS.forEach((p) => add(p, 'prop'));
for (const m of L.MATERIALS.slice(0, 30)) for (const p of L.PROPS.slice(0, 50)) add(`${m} ${p}`, 'prop');
L.PLACES.forEach((p) => add(p, 'place'));
for (const p of L.PLACES.slice(0, 80))
  for (const t of ['at night', 'at dusk', 'in fog', 'in the rain', 'in snow', 'interior', 'ruined', 'aerial view'])
    add(`${p} ${t}`, 'place');
L.LOOK.forEach((p) => add(p, 'concept'));
L.MATERIALS.forEach((p) => add(p, 'material'));

const keys = [...cat.keys()];
console.log('phrases', keys.length);

// Concepts: what an image can be "read" as when there are no words (image → search terms).
const CONCEPTS = [
  ...new Set([...L.SUBJECTS, ...L.CREATURES, ...L.PROPS, ...L.PLACES, ...L.POSE_WORDS, ...L.ACTIONS, ...L.LOOK.slice(0, 80)].map(keyOf)),
];
// Gate prompts: first half = unsafe, second half = safe. The gate compares the two groups.
const GATE_BAD = ['nudity', 'naked body', 'explicit sexual content', 'pornography', 'gore', 'graphic violence and blood'];
const GATE_OK = [
  'a fully clothed person',
  'a fantasy illustration',
  'a photograph of an object',
  'a landscape',
  'an animal',
  'armor and weapons',
];

// ---- embed ----
const tok = await AutoTokenizer.from_pretrained('Xenova/mobileclip_s0');
const model = await CLIPTextModelWithProjection.from_pretrained('Xenova/mobileclip_s0', { dtype: 'fp32' });
async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const { text_embeds } = await model(tok(batch, { padding: 'max_length', truncation: true }));
    const data = text_embeds.normalize().data;
    for (let b = 0; b < batch.length; b++) out.push(data.slice(b * DIM, (b + 1) * DIM));
    if (i % 1280 === 0) process.stdout.write(`\r  ${i}/${texts.length}`);
  }
  process.stdout.write('\n');
  return out;
}
// A phrase's vector = mean of two framings, so it matches both photos and artwork.
async function phraseVecs(list) {
  const a = await embed(list.map((k) => `a photo of ${k}`));
  const b = await embed(list.map((k) => `fantasy art of ${k}`));
  return a.map((v, i) => {
    const m = new Float32Array(DIM);
    let n = 0;
    for (let d = 0; d < DIM; d++) {
      m[d] = v[d] + b[i][d];
      n += m[d] * m[d];
    }
    n = Math.sqrt(n);
    for (let d = 0; d < DIM; d++) m[d] /= n;
    return m;
  });
}
function pack(rows) {
  const n = rows.length,
    buf = Buffer.alloc(n * 4 + n * DIM);
  rows.forEach((r, i) => {
    let mx = 0;
    for (const x of r) mx = Math.max(mx, Math.abs(x));
    const s = mx / 127 || 1e-8;
    buf.writeFloatLE(s, i * 4);
    for (let d = 0; d < DIM; d++) buf.writeInt8(Math.max(-127, Math.min(127, Math.round(r[d] / s))), n * 4 + i * DIM + d);
  });
  return buf;
}

fs.rmSync(path.join(OUT, 'vec'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vec'), { recursive: true });
const vecs = await phraseVecs(keys);
const shards = new Map();
keys.forEach((k, i) => {
  const s = shardOf(k);
  if (!shards.has(s)) shards.set(s, []);
  shards.get(s).push(i);
});
for (const [s, idx] of shards) fs.writeFileSync(path.join(OUT, 'vec', `${s}.bin`), pack(idx.map((i) => vecs[i])));
fs.writeFileSync(path.join(OUT, 'concepts.bin'), pack(await phraseVecs(CONCEPTS)));
fs.writeFileSync(path.join(OUT, 'gate.bin'), pack(await embed([...GATE_BAD, ...GATE_OK])));

// Keys are stored grouped by shard, in the same order as the rows of that shard's file.
const ordered = [...shards.values()].flat().map((i) => keys[i]);
const CATS = ['pose', 'figure', 'creature', 'prop', 'place', 'concept', 'material'];
const booru = Object.fromEntries(Object.entries(L.BOORU).map(([k, v]) => [keyOf(k), v]));
fs.writeFileSync(
  path.join(OUT, 'vocab.json'),
  JSON.stringify({
    v: 1,
    dim: DIM,
    keys: ordered,
    cat: ordered.map((k) => CATS.indexOf(cat.get(k))).join(''),
    cats: CATS,
    concepts: CONCEPTS,
    gate: { bad: GATE_BAD.length, ok: GATE_OK.length },
    booru,
    scry: L.SCRYFALL_ART,
    disp: Object.fromEntries(disp),
  }),
);
const size = (p) => fs.statSync(p).size;
const vecBytes = [...shards.keys()].reduce((t, s) => t + size(path.join(OUT, 'vec', `${s}.bin`)), 0);
console.log(
  `shards ${shards.size}, vectors ${(vecBytes / 1e6).toFixed(2)}MB total, vocab.json ${(size(path.join(OUT, 'vocab.json')) / 1e3).toFixed(0)}KB, concepts ${(size(path.join(OUT, 'concepts.bin')) / 1e3).toFixed(0)}KB`,
);

export function shardOf(k) {
  return k.split(' ')[0].replace(/[^a-z0-9-]/g, '_');
}
