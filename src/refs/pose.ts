/** Poses: read a stick-figure sketch into joints, convert MoveNet output to the same joints,
 *  compare two poses by limb direction (mirrored and left/right-swapped count as matches),
 *  and describe a pose in search words. Coordinates are image-normalised (0..1, y down). */

export type Pt = { x: number; y: number; c: number }; // c = confidence 0..1
/** head, neck, hip, and each limb's middle and end joint. A/B are unordered sides. */
export interface Skeleton {
  head: Pt;
  neck: Pt;
  hip: Pt;
  elbowA: Pt;
  wristA: Pt;
  elbowB: Pt;
  wristB: Pt;
  kneeA: Pt;
  ankleA: Pt;
  kneeB: Pt;
  ankleB: Pt;
  from: 'sketch' | 'model';
}

// ---------------------------------------------------------------- MoveNet → skeleton
/** MoveNet singlepose keypoints [y, x, score] × 17, in the padded square the model saw. */
export function fromMoveNet(k: Float32Array, pad: { sx: number; sy: number; ox: number; oy: number }): Skeleton | null {
  const P = (i: number): Pt => ({ x: (k[i * 3 + 1] - pad.ox) / pad.sx, y: (k[i * 3] - pad.oy) / pad.sy, c: k[i * 3 + 2] });
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, c: Math.min(a.c, b.c) });
  const nose = P(0),
    ls = P(5),
    rs = P(6),
    le = P(7),
    re = P(8),
    lw = P(9),
    rw = P(10),
    lh = P(11),
    rh = P(12),
    lk = P(13),
    rk = P(14),
    la = P(15),
    ra = P(16);
  const sk: Skeleton = {
    head: nose,
    neck: mid(ls, rs),
    hip: mid(lh, rh),
    elbowA: le,
    wristA: lw,
    elbowB: re,
    wristB: rw,
    kneeA: lk,
    ankleA: la,
    kneeB: rk,
    ankleB: ra,
    from: 'model',
  };
  const good = [sk.neck, sk.hip, le, re, lw, rw, lk, rk, la, ra].filter((p) => p.c > 0.3).length;
  return good >= 6 && sk.neck.c > 0.3 && sk.hip.c > 0.25 ? sk : null;
}

// ---------------------------------------------------------------- sketch reader
interface Gray {
  w: number;
  h: number;
  ink: Uint8Array;
} // 1 = stroke

/** Is this a line drawing (dark strokes on a light, mostly empty background)? */
export function looksLikeSketch(img: ImageData): boolean {
  const d = img.data,
    n = img.width * img.height;
  let light = 0,
    dark = 0,
    sat = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4],
      g = d[i * 4 + 1],
      b = d[i * 4 + 2];
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b),
      l = (mx + mn) / 2;
    if (l > 200) light++;
    else if (l < 110) dark++;
    if (mx - mn > 60) sat++;
  }
  return light / n > 0.6 && dark / n > 0.005 && dark / n < 0.3 && sat / n < 0.15;
}

function binarize(img: ImageData, S: number): Gray {
  // downscale to S on the long side (nearest), dark pixels are ink
  const sc = S / Math.max(img.width, img.height),
    w = Math.max(8, Math.round(img.width * sc)),
    h = Math.max(8, Math.round(img.height * sc));
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // darkest pixel in the source block, so thin lines survive the downscale
      let m = 255;
      const x0 = Math.floor(x / sc),
        x1 = Math.min(img.width, Math.ceil((x + 1) / sc)),
        y0 = Math.floor(y / sc),
        y1 = Math.min(img.height, Math.ceil((y + 1) / sc));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          m = Math.min(m, (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3);
        }
      ink[y * w + x] = m < 140 ? 1 : 0;
    }
  return { w, h, ink };
}

/** Zhang–Suen thinning: strokes → 1-pixel-wide skeleton. */
function thin(g: Gray): Uint8Array {
  const { w, h } = g,
    a = g.ink.slice();
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const del: number[] = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!a[y * w + x]) continue;
          const p = [
            at(x, y - 1),
            at(x + 1, y - 1),
            at(x + 1, y),
            at(x + 1, y + 1),
            at(x, y + 1),
            at(x - 1, y + 1),
            at(x - 1, y),
            at(x - 1, y - 1),
          ];
          const B = p.reduce((s, v) => s + v, 0);
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) A++;
          if (A !== 1) continue;
          if (step === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          del.push(y * w + x);
        }
      for (const i of del) a[i] = 0;
      if (del.length) changed = true;
    }
  }
  return a;
}

/** Enclosed background regions (the drawn head circle is one). */
function holes(g: Gray): Array<{ cx: number; cy: number; area: number; r: number; round: number }> {
  const { w, h, ink } = g,
    seen = new Uint8Array(w * h),
    out: Array<{ cx: number; cy: number; area: number; r: number; round: number }> = [];
  const flood = (start: number) => {
    const st = [start],
      px: number[] = [];
    seen[start] = 1;
    let border = false;
    while (st.length) {
      const i = st.pop()!,
        x = i % w,
        y = (i / w) | 0;
      px.push(i);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && !ink[j]) {
          seen[j] = 1;
          st.push(j);
        }
      }
    }
    return { px, border };
  };
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || ink[i]) continue;
    const { px, border } = flood(i);
    if (border || px.length < 12) continue;
    let sx = 0,
      sy = 0,
      x0 = w,
      x1 = 0,
      y0 = h,
      y1 = 0;
    for (const j of px) {
      const x = j % w,
        y = (j / w) | 0;
      sx += x;
      sy += y;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const bw = x1 - x0 + 1,
      bh = y1 - y0 + 1;
    // a circle fills ~78% of its box and is about as wide as tall; the gap between raised arms is a triangle
    const round = ((px.length / (bw * bh)) * Math.min(bw, bh)) / Math.max(bw, bh);
    out.push({ cx: sx / px.length, cy: sy / px.length, area: px.length, r: Math.sqrt(px.length / Math.PI), round });
  }
  return out.sort((a, b) => b.round * Math.sqrt(b.area) - a.round * Math.sqrt(a.area));
}

/** Read a stick figure: a circle (or blob) head, a spine, two arms, two legs. */
export function readSketch(img: ImageData): Skeleton | null {
  const S = 160;
  const g = binarize(img, S),
    { w, h } = g;
  const sk = thin(g);
  const inkIdx: number[] = [];
  for (let i = 0; i < w * h; i++) if (sk[i]) inkIdx.push(i);
  if (inkIdx.length < 30) return null;
  let minY = h,
    maxY = 0;
  for (const i of inkIdx) {
    const y = (i / w) | 0;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const figH = Math.max(10, maxY - minY);

  // head: the biggest enclosed hole in the top part of the figure; else the thickest blob; else the top end
  let head: { x: number; y: number; r: number } | null = null;
  const hs = holes(g).filter((o) => o.cy < minY + figH * 0.6 && o.r < figH * 0.3 && o.round > 0.55);
  if (hs.length) head = { x: hs[0].cx, y: hs[0].cy, r: hs[0].r + 1.5 };
  if (!head) {
    // filled head: ink pixel farthest from any background pixel
    let best = 0,
      bi = -1;
    for (let i = 0; i < w * h; i++) {
      if (!g.ink[i]) continue;
      const x = i % w,
        y = (i / w) | 0;
      let d = 0;
      while (
        d < 20 &&
        g.ink[Math.min(h - 1, y + d) * w + x] &&
        g.ink[Math.max(0, y - d) * w + x] &&
        g.ink[y * w + Math.min(w - 1, x + d)] &&
        g.ink[y * w + Math.max(0, x - d)]
      )
        d++;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (bi >= 0 && best >= 4 && ((bi / w) | 0) < minY + figH * 0.5) head = { x: bi % w, y: (bi / w) | 0, r: best + 1.5 };
  }

  // body skeleton = skeleton minus the head ring
  const inHead = (i: number) => !!head && Math.hypot((i % w) - head.x, ((i / w) | 0) - head.y) <= head.r + 1.5;
  const body = new Uint8Array(w * h);
  for (const i of inkIdx) if (!inHead(i)) body[i] = 1;
  const nb = (i: number) => {
    const x = i % w,
      y = (i / w) | 0,
      out: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && body[ny * w + nx]) out.push(ny * w + nx);
      }
    return out;
  };
  // neck zone: every body pixel just outside the head — arms and spine often all start there
  let neck = -1,
    nd = 1e9;
  for (let i = 0; i < w * h; i++) {
    if (!body[i]) continue;
    const d = head ? Math.hypot((i % w) - head.x, ((i / w) | 0) - head.y) : (i / w) | 0;
    if (d < nd) {
      nd = d;
      neck = i;
    }
  }
  if (neck < 0) return null;
  const zone = head ? head.r + Math.max(3, figH * 0.07) : 2;
  const roots: number[] = [];
  for (let i = 0; i < w * h; i++)
    if (body[i] && Math.hypot((i % w) - (neck % w), ((i / w) | 0) - ((neck / w) | 0)) <= zone - (head ? head.r : 0) + 2) roots.push(i);
  if (head)
    for (let i = 0; i < w * h; i++)
      if (body[i] && !roots.includes(i) && Math.hypot((i % w) - head.x, ((i / w) | 0) - head.y) <= zone) roots.push(i);

  // geodesic tree from the neck zone (all roots at distance 0; they share the neck as their parent)
  const par = new Int32Array(w * h).fill(-1),
    dist = new Int32Array(w * h).fill(-1);
  const q = [neck, ...roots.filter((r) => r !== neck)];
  for (const r of q) {
    dist[r] = 0;
    if (r !== neck) par[r] = neck;
  }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    for (const j of nb(i))
      if (dist[j] < 0) {
        dist[j] = dist[i] + 1;
        par[j] = i;
        q.push(j);
      }
  }
  // limb ends: reached pixels with one neighbour, far enough from the neck
  const ends = q.filter((i) => i !== neck && nb(i).length === 1 && dist[i] > figH * 0.12);
  if (ends.length < 3) return null;
  const path = (i: number) => {
    const p: number[] = [];
    for (let c = i; c >= 0; c = par[c]) p.push(c);
    return p.reverse();
  }; // neck → end
  // keep the 4 longest distinct limbs
  const limbs = ends
    .map((e) => ({ e, p: path(e) }))
    .sort((a, b) => b.p.length - a.p.length)
    .slice(0, 4);
  // legs: the pair sharing the longest stretch from the neck (they share the spine)
  let bestPair: [number, number] = [0, 1],
    bestShared = -1;
  for (let a = 0; a < limbs.length; a++)
    for (let b = a + 1; b < limbs.length; b++) {
      let s = 0;
      while (s < limbs[a].p.length && s < limbs[b].p.length && limbs[a].p[s] === limbs[b].p[s]) s++;
      // tie-break toward the lower pair (legs hang below arms)
      const low = ((limbs[a].e / w) | 0) + ((limbs[b].e / w) | 0);
      const score = s * 1000 + low;
      if (score > bestShared) {
        bestShared = score;
        bestPair = [a, b];
      }
    }
  const legs = bestPair.map((k) => limbs[k]);
  const arms = limbs.filter((_, k) => !bestPair.includes(k));
  let shared = 0;
  while (shared < legs[0].p.length && shared < legs[1].p.length && legs[0].p[shared] === legs[1].p[shared]) shared++;
  const hipIdx = legs[0].p[Math.max(0, shared - 1)];

  const P = (i: number, c = 1): Pt => ({ x: (i % w) / w, y: ((i / w) | 0) / h, c });
  /** middle joint: the point of greatest bend along the limb, or the midpoint if it's straight */
  const bend = (p: number[]): number => {
    const a = p[0],
      b = p[p.length - 1],
      ax = a % w,
      ay = (a / w) | 0,
      bx = b % w,
      by = (b / w) | 0,
      L = Math.hypot(bx - ax, by - ay) || 1;
    let best = p[(p.length / 2) | 0],
      bd = 0;
    for (const i of p) {
      const x = i % w,
        y = (i / w) | 0,
        d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    return bd > p.length * 0.08 ? best : p[(p.length / 2) | 0];
  };
  const legSeg = (l: { p: number[] }) => l.p.slice(Math.max(0, shared - 1));
  const armSeg = (l: { p: number[] }) => {
    // the arm starts where it leaves the spine
    let s = 0;
    const spine = legs[0].p;
    while (s < l.p.length && s < spine.length && l.p[s] === spine[s]) s++;
    return l.p.slice(Math.max(0, s - 1));
  };
  const la = legSeg(legs[0]),
    lb = legSeg(legs[1]);
  const aa = arms[0] ? armSeg(arms[0]) : null,
    ab = arms[1] ? armSeg(arms[1]) : null;
  const neckPt = P(neck),
    headPt = head ? { x: head.x / w, y: head.y / h, c: 1 } : { ...neckPt, y: neckPt.y - 0.08 };
  const miss = (): Pt => ({ ...neckPt, c: 0 });
  return {
    head: headPt,
    neck: neckPt,
    hip: P(hipIdx),
    elbowA: aa ? P(bend(aa)) : miss(),
    wristA: aa ? P(aa[aa.length - 1]) : miss(),
    elbowB: ab ? P(bend(ab)) : miss(),
    wristB: ab ? P(ab[ab.length - 1]) : miss(),
    kneeA: P(bend(la)),
    ankleA: P(la[la.length - 1]),
    kneeB: P(bend(lb)),
    ankleB: P(lb[lb.length - 1]),
    from: 'sketch',
  };
}

// ---------------------------------------------------------------- comparison
type Limb = [keyof Skeleton, keyof Skeleton, number]; // from, to, weight
const LIMBS_A: Limb[] = [
  ['neck', 'elbowA', 1],
  ['elbowA', 'wristA', 0.8],
];
const LIMBS_B: Limb[] = [
  ['neck', 'elbowB', 1],
  ['elbowB', 'wristB', 0.8],
];
const LEGS_A: Limb[] = [
  ['hip', 'kneeA', 1],
  ['kneeA', 'ankleA', 0.8],
];
const LEGS_B: Limb[] = [
  ['hip', 'kneeB', 1],
  ['kneeB', 'ankleB', 0.8],
];
const TORSO: Limb = ['neck', 'hip', 1.4];

function dir(s: Skeleton, a: keyof Skeleton, b: keyof Skeleton, flip: boolean): [number, number, number] | null {
  const p = s[a] as Pt,
    q = s[b] as Pt;
  const c = Math.min(p.c, q.c);
  if (c < 0.3) return null;
  let dx = q.x - p.x;
  const dy = q.y - p.y,
    L = Math.hypot(dx, dy);
  if (L < 1e-3) return null;
  if (flip) dx = -dx;
  return [dx / L, dy / L, c];
}

/** −1 … 1: how alike two poses are by limb direction. Mirror images and swapped sides count as the same pose. */
export function poseSimilarity(q: Skeleton, c: Skeleton): number {
  let best = -1;
  for (const flip of [false, true])
    for (const swapArms of [false, true])
      for (const swapLegs of [false, true]) {
        const pairs: Array<[Limb, Limb]> = [
          [TORSO, TORSO],
          ...LIMBS_A.map((l, i): [Limb, Limb] => [l, (swapArms ? LIMBS_B : LIMBS_A)[i]]),
          ...LIMBS_B.map((l, i): [Limb, Limb] => [l, (swapArms ? LIMBS_A : LIMBS_B)[i]]),
          ...LEGS_A.map((l, i): [Limb, Limb] => [l, (swapLegs ? LEGS_B : LEGS_A)[i]]),
          ...LEGS_B.map((l, i): [Limb, Limb] => [l, (swapLegs ? LEGS_A : LEGS_B)[i]]),
        ];
        let s = 0,
          wsum = 0;
        for (const [lq, lc] of pairs) {
          const a = dir(q, lq[0], lq[1], flip),
            b = dir(c, lc[0], lc[1], false);
          if (!a || !b) continue;
          const wt = lq[2] * b[2];
          s += (a[0] * b[0] + a[1] * b[1]) * wt;
          wsum += wt;
        }
        if (wsum >= 3) best = Math.max(best, s / wsum);
      }
  return best;
}

// ---------------------------------------------------------------- words
/** Search words for a pose, so sources are asked for the right kind of figure. */
export function describePose(s: Skeleton): string[] {
  const ang = (a: Pt, b: Pt) => Math.atan2(b.x - a.x, b.y - a.y) * (180 / Math.PI); // 0 = straight down
  const torso = Math.abs(ang(s.neck, s.hip));
  const thighA = ang(s.hip, s.kneeA),
    thighB = ang(s.hip, s.kneeB);
  const spread = Math.abs(thighA - thighB);
  const up = (w: Pt) => w.c > 0.3 && w.y < s.neck.y;
  // a lower leg lying along the ground = kneeling; both thighs near level = crouching
  const flat = (k: Pt, a: Pt) => Math.abs(a.y - k.y) < 0.45 * Math.abs(a.x - k.x) && k.y > s.hip.y;
  const level = (k: Pt) => Math.abs(k.y - s.hip.y) < 0.6 * Math.abs(k.x - s.hip.x);
  const out: string[] = [];
  if (torso > 60) out.push('lying down');
  else if (flat(s.kneeA, s.ankleA) || flat(s.kneeB, s.ankleB)) out.push('kneeling');
  else if (level(s.kneeA) && level(s.kneeB)) out.push('crouching');
  else if (up(s.wristA) && up(s.wristB)) out.push(spread > 50 ? 'jumping' : 'arms raised');
  else if (spread > 70) out.push(torso > 15 ? 'lunging' : 'fighting stance');
  else if (spread > 40) out.push('running');
  else if (torso > 20) out.push('dynamic pose');
  else out.push('standing');
  out.push('full body');
  if (!out.includes('dynamic pose') && out[0] !== 'standing') out.push('dynamic pose');
  return out;
}

/** Letterbox a bitmap into MoveNet's 192² square; returns the int32 RGB input and the padding used. */
export function movenetInput(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
): { x: Int32Array; pad: { sx: number; sy: number; ox: number; oy: number } } {
  const S = 192,
    sc = S / Math.max(bmp.width, bmp.height),
    w = bmp.width * sc,
    h = bmp.height * sc,
    ox = (S - w) / 2,
    oy = (S - h) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(bmp, ox, oy, w, h);
  const d = ctx.getImageData(0, 0, S, S).data,
    x = new Int32Array(S * S * 3);
  for (let i = 0; i < S * S; i++) {
    x[i * 3] = d[i * 4];
    x[i * 3 + 1] = d[i * 4 + 1];
    x[i * 3 + 2] = d[i * 4 + 2];
  }
  return { x, pad: { sx: w / S, sy: h / S, ox: ox / S, oy: oy / S } };
}
