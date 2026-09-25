// ---- stick figures drawn straight into pixels
export type J = Record<'neck' | 'hip' | 'le' | 'lw' | 're' | 'rw' | 'lk' | 'la' | 'rk' | 'ra', [number, number]>;
export const POSES: Record<string, J> = {
  standing: {
    neck: [0, -60],
    hip: [0, 20],
    le: [-25, -20],
    lw: [-30, 15],
    re: [25, -20],
    rw: [30, 15],
    lk: [-12, 65],
    la: [-15, 110],
    rk: [12, 65],
    ra: [15, 110],
  },
  arms_up: {
    neck: [0, -60],
    hip: [0, 20],
    le: [-30, -90],
    lw: [-35, -125],
    re: [30, -90],
    rw: [35, -125],
    lk: [-12, 65],
    la: [-15, 110],
    rk: [12, 65],
    ra: [15, 110],
  },
  lunge: {
    neck: [10, -55],
    hip: [0, 20],
    le: [45, -45],
    lw: [85, -40],
    re: [-30, -30],
    rw: [-55, -10],
    lk: [50, 55],
    la: [60, 110],
    rk: [-45, 55],
    ra: [-85, 95],
  },
  kneeling: {
    neck: [0, -40],
    hip: [0, 35],
    le: [-25, 0],
    lw: [-30, 30],
    re: [25, 0],
    rw: [30, 30],
    lk: [-20, 75],
    la: [-60, 80],
    rk: [25, 70],
    ra: [25, 110],
  },
};
/** `gap` leaves that many pixels between each upper limb and the forearm/shin below it, the way quick
 *  hand-drawn strokes often fail to touch. */
export function draw(j: J, mirror = false, gap = 0): ImageData {
  const S = 256,
    data = new Uint8ClampedArray(S * S * 4).fill(255);
  const dot = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const px = Math.round(x + dx),
          py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= S || py >= S) continue;
        const i = (py * S + px) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  };
  const P = (k: keyof J) => [S / 2 + (mirror ? -1 : 1) * j[k][0], S / 2 + j[k][1]];
  const line = (a: keyof J, b: keyof J) => {
    const [x0, y0] = P(a),
      [x1, y1] = P(b),
      n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    const skip = a === 'neck' || a === 'hip' ? 0 : gap; // forearms and shins start a little way off
    for (let i = Math.min(n, skip); i <= n; i++) dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
  };
  const [hx, hy] = P('neck');
  for (let a = 0; a < 360; a += 2) dot(hx + 16 * Math.cos((a * Math.PI) / 180), hy - 18 + 16 * Math.sin((a * Math.PI) / 180));
  (
    ['neck', 'hip', 'neck', 'le', 'le', 'lw', 'neck', 're', 're', 'rw', 'hip', 'lk', 'lk', 'la', 'hip', 'rk', 'rk', 'ra'] as Array<keyof J>
  ).forEach((k, i, a) => i % 2 === 0 && line(k, a[i + 1]));
  return { width: S, height: S, data, colorSpace: 'srgb' } as ImageData;
}

