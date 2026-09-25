import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completions, corrected, makePlan, resolveQuery, segment, vocabFrom, type VocabFile } from '../../src/refs/vocab';
import { describePose, poseSimilarity, readSketch, type Skeleton } from '../../src/refs/pose';

const v = vocabFrom(JSON.parse(readFileSync(new URL('../../public/refs/vocab.json', import.meta.url), 'utf8')) as VocabFile);

describe('typo repair', () => {
  it.each([
    ['man holding sow', 'man holding sword'],
    ['a man dynamic holding sowrd', 'a man dynamic holding sword'],
    ['dragn in flight', 'dragon in flight'],
    ['dargon perched', 'dragon perched'],
    ['holding a spere', 'holding a spear'],
    ['wizzard casting', 'wizard casting'],
    ['castel on a clif', 'castle on a cliff'],
    ['owl in flihgt', 'owl in flight'],
    ['lanturn', 'lantern'],
    ['potoin bottle', 'potion bottle'],
    ['tavren interior', 'tavern interior'],
    ['forrest path', 'forest path'],
    ['samuri drawing katana', 'samurai drawing katana'],
    ['barbarain', 'barbarian'],
    ['kneelng knight', 'kneeling knight'],
    ['backlit silhoutte', 'backlit silhouette'],
    ['wolf howlign', 'wolf howling'],
    ['swrod lunge', 'sword lunge'],
    ['dynmaic pose', 'dynamic pose'],
    ['woman holding bo', 'woman holding bow'],
    ['knight holding a sp', 'knight holding a spear'],
    ['wolf howl', 'wolf howling'],
  ])('%s → %s', (typed, want) => {
    expect(resolveQuery(v, typed)).toBe(want);
  });
  it('leaves correct words and unknown words alone', () => {
    expect(resolveQuery(v, 'knight holding sword')).toBe('knight holding sword');
    expect(resolveQuery(v, 'glorptastic zweihander')).toBe('glorptastic zweihander');
  });
  it('tells a typo fix from a completion', () => {
    expect(corrected('man holding sow', 'man holding sword')).toBe(true);
    expect(corrected('man holding sw', 'man holding sword')).toBe(false);
  });
});

describe('suggestions and plans', () => {
  it('completes a half-typed phrase', () => {
    expect(completions(v, 'man holding sw')[0]).toBe('man holding sword');
  });
  it('finds phrases and the joined subject + action', () => {
    const keys = segment(v, 'a man dynamic holding sword');
    expect(keys).toContain('holding sword');
    expect(keys).toContain('man holding sword');
  });
  it('guesses the mode from the words', () => {
    expect(makePlan(v, 'a man dynamic holding sword', 'auto', false).mode).toBe('pose');
    expect(makePlan(v, 'dragon in flight', 'auto', false).mode).toBe('creature');
    expect(makePlan(v, 'castle on a cliff at night', 'auto', false).mode).toBe('place');
    expect(makePlan(v, 'ornate longsword', 'auto', false).mode).toBe('prop');
    expect(makePlan(v, 'ornate longsword', 'place', false).mode).toBe('place'); // an explicit mode wins
  });
  it('builds source-specific terms', () => {
    const p = makePlan(v, 'knight holding a sword from below', 'auto', false);
    expect(p.booru).toEqual(expect.arrayContaining(['holding_sword', 'from_below']));
    expect(p.scry).toEqual(expect.arrayContaining(['knight', 'sword']));
    expect(p.nouns).toEqual(expect.arrayContaining(['knight', 'sword']));
  });
});

// ---- stick figures drawn straight into pixels
type J = Record<'neck' | 'hip' | 'le' | 'lw' | 're' | 'rw' | 'lk' | 'la' | 'rk' | 'ra', [number, number]>;
const POSES: Record<string, J> = {
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
function draw(j: J, mirror = false): ImageData {
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
    for (let i = 0; i <= n; i++) dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
  };
  const [hx, hy] = P('neck');
  for (let a = 0; a < 360; a += 2) dot(hx + 16 * Math.cos((a * Math.PI) / 180), hy - 18 + 16 * Math.sin((a * Math.PI) / 180));
  (
    ['neck', 'hip', 'neck', 'le', 'le', 'lw', 'neck', 're', 're', 'rw', 'hip', 'lk', 'lk', 'la', 'hip', 'rk', 'rk', 'ra'] as Array<keyof J>
  ).forEach((k, i, a) => i % 2 === 0 && line(k, a[i + 1]));
  return { width: S, height: S, data, colorSpace: 'srgb' } as ImageData;
}

describe('stick-figure poses', () => {
  const read: Record<string, Skeleton> = {};
  it.each(Object.keys(POSES))('reads %s', (name) => {
    const s = readSketch(draw(POSES[name]));
    expect(s).not.toBeNull();
    read[name] = s!;
  });
  it('each pose matches itself best, mirrored too', () => {
    for (const name of Object.keys(POSES)) {
      const mirrored = readSketch(draw(POSES[name], true))!;
      const ranked = Object.keys(POSES).sort((a, b) => poseSimilarity(mirrored, read[b]) - poseSimilarity(mirrored, read[a]));
      expect(ranked[0], `mirrored ${name}`).toBe(name);
    }
  });
  it('describes poses in search words', () => {
    expect(describePose(read.arms_up)[0]).toBe('arms raised');
    expect(describePose(read.standing)[0]).toBe('standing');
    expect(describePose(read.kneeling)[0]).toBe('kneeling');
  });
});
