/** Pool of vision workers. Thumbnails are fetched and decoded here (network-bound, many at once);
 *  the workers only run the model (CPU-bound, one per worker). Highest-priority images go first. */

const MODEL = `${import.meta.env.BASE_URL}models/mobileclip_s0_vision_w8.onnx`;
const POSE_MODEL = new URL(`${import.meta.env.BASE_URL}models/movenet_lightning_w8.onnx`, location.href).href;
export type Pad = { sx: number; sy: number; ox: number; oy: number };
export interface Emb {
  vecs: Float32Array[];
  kps?: Float32Array;
  pad?: Pad;
}
const FETCHES = 28; // one host (wsrv.nl) over HTTP/2, so many can share a connection

type Job = {
  id: number;
  bmp: ImageBitmap;
  flip: boolean;
  pose: boolean;
  prio: number;
  resolve: (v: Emb) => void;
  reject: (e: unknown) => void;
};

let workers: Worker[] = [];
let idle: Worker[] = [];
let readyP: Promise<void> | null = null;
let failed = false;
const queue: Job[] = [];
const pending = new Map<number, Job>();
let nextId = 1;

export function poolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const phone = matchMedia('(pointer: coarse)').matches;
  return Math.max(1, Math.min(phone ? 2 : 6, cores - 2));
}

/** Starts the workers (idempotent). Resolves when the first one has the model loaded. */
export function warmVision(): Promise<void> {
  if (readyP) return readyP;
  readyP = new Promise<void>((resolve, reject) => {
    let ready = 0,
      errors = 0;
    const n = poolSize();
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'ready') {
          ready++;
          idle.push(w);
          pump();
          if (ready === 1) resolve();
        } else if (m.type === 'error') {
          if (++errors === n) {
            failed = true;
            reject(new Error(m.error));
          }
        } else if (m.type === 'vec') {
          const job = pending.get(m.id);
          pending.delete(m.id);
          idle.push(w);
          if (job) {
            if (m.error) job.reject(new Error(m.error));
            else job.resolve({ vecs: m.vecs as Float32Array[], kps: m.kps, pad: m.pad });
          }
          pump();
        }
      };
      w.postMessage({ type: 'load', model: new URL(MODEL, location.href).href, poseModel: POSE_MODEL });
      workers.push(w);
    }
  });
  readyP.catch(() => undefined);
  return readyP;
}
export const visionFailed = () => failed;

function pump() {
  queue.sort((a, b) => b.prio - a.prio);
  while (idle.length && queue.length) {
    const w = idle.pop()!,
      job = queue.shift()!;
    pending.set(job.id, job);
    w.postMessage({ type: 'embed', id: job.id, bmp: job.bmp, flip: job.flip, pose: job.pose }, [job.bmp]);
  }
}

/** Embed a bitmap (the user's image or crop): [vector] or [vector, mirrored vector], plus MoveNet joints when asked. */
export async function embedBitmap(bmp: ImageBitmap, flip = false, prio = 1e9, pose = false): Promise<Emb> {
  await warmVision();
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, bmp, flip, pose, prio, resolve, reject });
    pump();
  });
}

// ---- thumbnails: fetch → decode → embed, cached per URL for the session
const cache = new Map<string, Promise<Emb>>();
let inFlight = 0;
const waiting: Array<{ prio: number; go: () => void }> = [];
function slot(prio: number): Promise<void> {
  if (inFlight < FETCHES) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((go) => {
    waiting.push({
      prio,
      go: () => {
        inFlight++;
        go();
      },
    });
    waiting.sort((a, b) => b.prio - a.prio);
  });
}
function release() {
  inFlight--;
  waiting.shift()?.go();
}

export function embedUrl(url: string, prio: number, signal: AbortSignal, pose = false): Promise<Emb> {
  const ck = pose ? `${url}#pose` : url;
  const hit = cache.get(ck) ?? (pose ? undefined : cache.get(`${url}#pose`));
  if (hit) return hit;
  const p = (async () => {
    await slot(prio);
    let bmp: ImageBitmap;
    try {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`${r.status}`);
      bmp = await createImageBitmap(await r.blob());
    } finally {
      release();
    }
    return embedBitmap(bmp, false, prio, pose);
  })();
  cache.set(ck, p);
  p.catch(() => cache.delete(ck));
  return p;
}

export function stopVision() {
  for (const w of workers) w.terminate();
  workers = [];
  idle = [];
  readyP = null;
  queue.length = 0;
  pending.clear();
}
