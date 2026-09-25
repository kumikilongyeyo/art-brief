/** The pre-analysed card catalogs (scripts/refs/build_index.py): every image's MobileCLIP vector,
 *  clustered, plus MoveNet joints. A search reads the cluster centres (a few KB), then only the
 *  nearest clusters, and ranks exactly within them — no thumbnails are downloaded to rank a catalog. */
import { fromIndex, poseMatch, type Skeleton } from './pose';
import { DIM, V } from './vocab';

type Rows = { n: number; scale: Float32Array; q: Int8Array };
interface Meta { n: number; k: number; figures: number }
export interface IdxHit { row: number; sim: number; vec: Float32Array; pose?: number }

const base = (cat: string) => `${import.meta.env.BASE_URL}refs/idx/${cat}/`;
const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, f: () => Promise<T>): Promise<T> {
  if (!memo.has(key)) {
    const p = f();
    p.catch(() => memo.delete(key));
    memo.set(key, p);
  }
  return memo.get(key) as Promise<T>;
}
const bin = (url: string) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.arrayBuffer(); });
function parseRows(buf: ArrayBuffer, offset = 0): Rows {
  const n = (buf.byteLength - offset) / (4 + DIM);
  return { n, scale: new Float32Array(buf.slice(offset, offset + n * 4)), q: new Int8Array(buf, offset + n * 4) };
}
const rowDot = (r: Rows, i: number, v: Float32Array) => {
  let s = 0;
  const o = i * DIM;
  for (let d = 0; d < DIM; d++) s += r.q[o + d] * v[d];
  return s * r.scale[i];
};
const rowVec = (r: Rows, i: number) => {
  const out = new Float32Array(DIM), s = r.scale[i], o = i * DIM;
  for (let d = 0; d < DIM; d++) out[d] = r.q[o + d] * s;
  return out;
};

const meta = (cat: string) => once(`${cat}:meta`, () => fetch(`${base(cat)}meta.json${V}`).then((r) => r.json() as Promise<Meta>));
const centroids = (cat: string) => once(`${cat}:cent`, () => bin(`${base(cat)}centroids.bin${V}`).then((b) => parseRows(b)));
const cluster = (cat: string, k: number) =>
  once(`${cat}:c${k}`, () =>
    bin(`${base(cat)}c${k}.bin${V}`).then((b) => {
      const n = new DataView(b).getUint32(0, true);
      return { ids: new Uint32Array(b.slice(4, 4 + n * 4)), rows: parseRows(b, 4 + n * 4) };
    }),
  );
const poses = (cat: string) => once(`${cat}:pose`, () => bin(`${base(cat)}pose.bin${V}`).then((b) => new Uint8Array(b)));

/** Rows most like the query vector, best first. `probe` clusters are read (more = slower, more thorough). */
export async function nearest(cat: string, q: Float32Array, limit = 120, probe = 8): Promise<IdxHit[]> {
  const cent = await centroids(cat);
  const order = Array.from({ length: cent.n }, (_, k) => [rowDot(cent, k, q), k] as const).sort((a, b) => b[0] - a[0]).slice(0, probe);
  const parts = await Promise.all(order.map(([, k]) => cluster(cat, k)));
  const out: IdxHit[] = [];
  for (const { ids, rows } of parts) for (let i = 0; i < rows.n; i++) out.push({ row: ids[i], sim: rowDot(rows, i, q), vec: rowVec(rows, i) });
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}

/** Which rows show a figure (MoveNet found one when the index was built). */
export async function figureRows(cat: string): Promise<(row: number) => boolean> {
  const b = await poses(cat);
  return (row) => !!fromIndex(b, row);
}

/** Rows whose figure is in the query pose (every catalog figure is compared), best first. */
export async function byPose(cat: string, pose: Skeleton, limit = 120): Promise<Array<{ row: number; pose: number }>> {
  const [m, b] = await Promise.all([meta(cat), poses(cat)]);
  const out: Array<{ row: number; pose: number }> = [];
  for (let row = 0; row < m.n; row++) {
    const sk = fromIndex(b, row);
    if (!sk) continue;
    const s = poseMatch(pose, sk);
    if (s > 0) out.push({ row, pose: s });
  }
  return out.sort((a, b) => b.pose - a.pose).slice(0, limit);
}

const rowCluster = (cat: string) => once(`${cat}:rows`, () => bin(`${base(cat)}rows.bin${V}`).then((b) => new Uint16Array(b)));

/** A catalog row's vector (for rows found by pose, which still need a look score). */
export async function vectorOf(cat: string, row: number): Promise<Float32Array | null> {
  const k = (await rowCluster(cat))[row];
  if (k === undefined || k === 65535) return null;
  const { ids, rows } = await cluster(cat, k);
  const i = ids.indexOf(row);
  return i >= 0 ? rowVec(rows, i) : null;
}
