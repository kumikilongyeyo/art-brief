/** Pool of vision workers. The page downloads each model once and hands the bytes to every worker;
 *  thumbnails are fetched and decoded here (network-bound, many at once) and the workers only run the
 *  models (CPU-bound, one image each). Jobs carry their search's AbortSignal and are dropped on abort. */

declare const __ORT_VERSION__: string;
const BASE = import.meta.env.BASE_URL;
const MODEL = `${BASE}models/mobileclip_s0_vision_w8.onnx`;
const POSE_MODEL = `${BASE}models/movenet_lightning_w8.onnx`;
const WASM = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist/ort-wasm-simd-threaded.wasm`;
const FETCHES = 28; // thumbnails in flight at once

export type Pad = { sx: number; sy: number; ox: number; oy: number };
export interface Emb {
  vecs: Float32Array[];
  kps?: Float32Array;
  pad?: Pad;
}
type Job = { id: number; bmp: ImageBitmap; flip: boolean; pose: boolean; prio: number; signal?: AbortSignal; resolve: (v: Emb) => void; reject: (e: unknown) => void };

// ---------------------------------------------------------------- model bytes, downloaded once
export interface VisionState {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  loaded: number; // bytes of the ranking model received so far
  total: number;
}
const state: VisionState = { phase: 'idle', loaded: 0, total: 0 };
const listeners = new Set<() => void>();
export const visionState = (): VisionState => ({ ...state });
export function onVisionState(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
const emit = () => listeners.forEach((f) => f());

async function download(url: string, progress?: (got: number, total: number) => void): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      const total = +(r.headers.get('Content-Length') ?? 0);
      if (!progress || !r.body) return await r.arrayBuffer();
      const reader = r.body.getReader(),
        parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        progress(got, total);
      }
      const out = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out.buffer;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

let bytesP: Promise<{ model: ArrayBuffer; wasm: ArrayBuffer }> | null = null;
function modelBytes() {
  bytesP ??= Promise.all([
    download(MODEL, (got, total) => {
      state.loaded = got;
      state.total = total || 14_300_000;
      emit();
    }),
    download(WASM),
  ]).then(([model, wasm]) => ({ model, wasm }));
  bytesP.catch(() => (bytesP = null));
  return bytesP;
}
let poseBytesP: Promise<ArrayBuffer> | null = null;

// ---------------------------------------------------------------- workers
const idle: Worker[] = [];
const hasPose = new WeakSet<Worker>();
const poseRequested = new WeakSet<Worker>();
let readyP: Promise<void> | null = null;
const queue: Job[] = [];
const pending = new Map<number, Job>();
let nextId = 1;

export function poolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const phone = matchMedia('(pointer: coarse)').matches;
  return Math.max(1, Math.min(phone ? 2 : 6, cores - 2));
}

function spawn(bytes: { model: ArrayBuffer; wasm: ArrayBuffer }, onReady: () => void, onFail: () => void, retry = true) {
  const w = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    w.terminate();
    if (retry) setTimeout(() => spawn(bytes, onReady, onFail, false), 1000); // one retry per slot
    else onFail();
  };
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
      settled = true;
      idle.push(w);
      onReady();
      pump();
    } else if (m.type === 'error') fail();
    else if (m.type === 'vec') {
      const job = pending.get(m.id);
      pending.delete(m.id);
      idle.push(w);
      if (job) {
        if (m.error) job.reject(new Error(m.error));
        else job.resolve({ vecs: m.vecs as Float32Array[], kps: m.kps, pad: m.pad });
      }
      pump();
    } else if (m.type === 'pose-ready') {
      hasPose.add(w);
      pump();
    }
  };
  w.onerror = fail;
  // copies, not transfers: every worker needs its own
  w.postMessage({ type: 'load', model: bytes.model.slice(0), wasm: bytes.wasm.slice(0) });
}

/** Starts the pool (idempotent). Resolves when the first worker has the model. */
export function warmVision(): Promise<void> {
  if (readyP) return readyP;
  state.phase = 'loading';
  emit();
  readyP = modelBytes().then(
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        let ready = 0,
          failed = 0;
        const n = poolSize();
        for (let i = 0; i < n; i++)
          spawn(
            bytes,
            () => {
              if (++ready === 1) {
                state.phase = 'ready';
                emit();
                resolve();
              }
            },
            () => {
              if (++failed === n) reject(new Error('no vision worker could start'));
            },
          );
      }),
  );
  readyP.catch(() => {
    state.phase = 'failed';
    emit();
    readyP = null; // a later search may try again (e.g. once the network is back)
  });
  return readyP;
}
export const visionFailed = () => state.phase === 'failed';

async function ensurePose(w: Worker) {
  poseBytesP ??= download(POSE_MODEL);
  poseBytesP.catch(() => (poseBytesP = null));
  const b = await poseBytesP;
  w.postMessage({ type: 'load-pose', model: b.slice(0) });
}

function pump() {
  for (let i = queue.length - 1; i >= 0; i--)
    if (queue[i].signal?.aborted) {
      const [job] = queue.splice(i, 1);
      job.bmp.close();
      job.reject(new DOMException('aborted', 'AbortError'));
    }
  queue.sort((a, b) => b.prio - a.prio);
  for (let k = 0; k < idle.length && queue.length; ) {
    const w = idle[k];
    const at = queue.findIndex((j) => !j.pose || hasPose.has(w));
    if (at < 0) {
      // this worker hasn't got the pose model yet: fetch it once, leave the worker for plain jobs
      if (!poseRequested.has(w)) {
        poseRequested.add(w);
        void ensurePose(w).catch(() => poseRequested.delete(w));
      }
      k++;
      continue;
    }
    const job = queue.splice(at, 1)[0];
    idle.splice(k, 1);
    pending.set(job.id, job);
    w.postMessage({ type: 'embed', id: job.id, bmp: job.bmp, flip: job.flip, pose: job.pose }, [job.bmp]);
  }
}

/** Embed a bitmap: [vector] or [vector, mirrored vector], plus MoveNet joints when asked. */
export async function embedBitmap(bmp: ImageBitmap, flip = false, prio = 1e9, pose = false, signal?: AbortSignal): Promise<Emb> {
  await warmVision();
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, bmp, flip, pose, prio, signal, resolve, reject });
    pump();
  });
}

// ---------------------------------------------------------------- thumbnails: fetch → decode → embed
const cache = new Map<string, Promise<Emb>>();
let inFlight = 0;
const waiting: Array<{ prio: number; signal: AbortSignal; go: () => void; stop: () => void }> = [];
function slot(prio: number, signal: AbortSignal): Promise<void> {
  if (inFlight < FETCHES) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((go, stop) => {
    waiting.push({ prio, signal, go: () => { inFlight++; go(); }, stop: () => stop(new DOMException('aborted', 'AbortError')) });
    waiting.sort((a, b) => b.prio - a.prio);
  });
}
function release() {
  inFlight--;
  for (;;) {
    const w = waiting.shift();
    if (!w) return;
    if (w.signal.aborted) {
      w.stop();
      continue;
    }
    w.go();
    return;
  }
}

export function embedUrl(url: string, prio: number, signal: AbortSignal, pose = false): Promise<Emb> {
  const ck = pose ? `${url}#pose` : url;
  const hit = cache.get(ck) ?? (pose ? undefined : cache.get(`${url}#pose`));
  if (hit) return hit;
  const p = (async () => {
    await slot(prio, signal);
    let bmp: ImageBitmap;
    try {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      bmp = await createImageBitmap(await r.blob());
    } finally {
      release();
    }
    return embedBitmap(bmp, false, prio, pose, signal);
  })();
  cache.set(ck, p);
  p.catch(() => cache.delete(ck));
  return p;
}
