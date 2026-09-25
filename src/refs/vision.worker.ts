/// <reference lib="webworker" />
// Runs MobileCLIP-S0's image encoder (and MoveNet, for poses) on ImageBitmaps sent from the page.
// The page downloads the model and runtime bytes once and posts them here, so N workers ≠ N downloads.
import * as ort from 'onnxruntime-web/wasm';
import { movenetInput } from './pose';

declare const __ORT_VERSION__: string;
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist/`; // the small .mjs loader
ort.env.wasm.numThreads = 1; // GitHub Pages can't send the headers threads need; parallelism comes from several workers

const S = 256;
let session: ort.InferenceSession | null = null;
let poseSession: ort.InferenceSession | null = null;
const canvas = new OffscreenCanvas(S, S);
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const poseCanvas = new OffscreenCanvas(192, 192);
const poseCtx = poseCanvas.getContext('2d', { willReadFrequently: true })!;
const OPTS: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

/** Shortest side to 256, centre crop — the model's own preprocessing. */
function pixels(bmp: ImageBitmap, flip: boolean): Float32Array {
  const sc = S / Math.min(bmp.width, bmp.height);
  const w = bmp.width * sc,
    h = bmp.height * sc;
  ctx.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? S : 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
  const d = ctx.getImageData(0, 0, S, S).data,
    n = S * S,
    x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    x[i] = d[i * 4] / 255;
    x[n + i] = d[i * 4 + 1] / 255;
    x[2 * n + i] = d[i * 4 + 2] / 255;
  }
  return x;
}

async function embed(bmp: ImageBitmap, flip: boolean): Promise<Float32Array> {
  const r = await session!.run({ pixel_values: new ort.Tensor('float32', pixels(bmp, flip), [1, 3, S, S]) });
  const e = r.image_embeds.data as Float32Array;
  let n = 0;
  for (const v of e) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(e, (v) => v / n);
}

async function pose(bmp: ImageBitmap) {
  const { x, pad } = movenetInput(poseCtx, bmp);
  const r = await poseSession!.run({ input: new ort.Tensor('int32', x, [1, 192, 192, 3]) });
  return { kps: Float32Array.from(r[Object.keys(r)[0]].data as Float32Array), pad };
}

type Msg =
  | { type: 'load'; model: ArrayBuffer; wasm: ArrayBuffer }
  | { type: 'load-pose'; model: ArrayBuffer }
  | { type: 'embed'; id: number; bmp: ImageBitmap; flip?: boolean; pose?: boolean };
self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  if (m.type === 'load') {
    try {
      ort.env.wasm.wasmBinary = m.wasm;
      session = await ort.InferenceSession.create(new Uint8Array(m.model), OPTS);
      self.postMessage({ type: 'ready' });
    } catch (e) {
      self.postMessage({ type: 'error', error: String(e) });
    }
    return;
  }
  if (m.type === 'load-pose') {
    try {
      poseSession ??= await ort.InferenceSession.create(new Uint8Array(m.model), OPTS);
      self.postMessage({ type: 'pose-ready' });
    } catch (e) {
      self.postMessage({ type: 'pose-error', error: String(e) });
    }
    return;
  }
  try {
    const out = [await embed(m.bmp, false)];
    if (m.flip) out.push(await embed(m.bmp, true));
    const p = m.pose && poseSession ? await pose(m.bmp) : undefined;
    m.bmp.close();
    self.postMessage({ type: 'vec', id: m.id, vecs: out, kps: p?.kps, pad: p?.pad }, [...out.map((v) => v.buffer), ...(p ? [p.kps.buffer] : [])]);
  } catch (e) {
    self.postMessage({ type: 'vec', id: m.id, error: String(e) });
  }
};
