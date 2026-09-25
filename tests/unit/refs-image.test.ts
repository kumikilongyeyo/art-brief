import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describePose, looksLikeSketch, readSketch } from '../../src/refs/pose';
import { drawingWords, vocabFrom, type VocabFile } from '../../src/refs/vocab';
import { draw, POSES } from './refs-draw';

const v = vocabFrom(JSON.parse(readFileSync(new URL('../../public/refs/vocab.json', import.meta.url), 'utf8')) as VocabFile);

// What a pasted image is read as: a stick figure (searched by its pose), or a picture (searched by its look).

const S = 256;
function image(shade: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = shade(x, y);
      data[i + 3] = 255;
    }
  return { width: S, height: S, data, colorSpace: 'srgb' } as ImageData;
}
/** 3px dark strokes on white paper. */
function lines(segs: Array<[number, number, number, number]>): ImageData {
  const img = image(() => 255);
  for (const [x0, y0, x1, y1] of segs) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let t = 0; t <= n; t++) {
      const x = Math.round(x0 + ((x1 - x0) * t) / n),
        y = Math.round(y0 + ((y1 - y0) * t) / n);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * S + x + dx) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 20;
        }
    }
  }
  return img;
}
const rect = (x0: number, y0: number, x1: number, y1: number): Array<[number, number, number, number]> => [
  [x0, y0, x1, y0],
  [x1, y0, x1, y1],
  [x1, y1, x0, y1],
  [x0, y1, x0, y0],
];

describe('drawing or picture', () => {
  it('a pale painting with a shaded figure is not a line drawing', () => {
    // a softly lit sky evens out to "paper", but the figure's darks are filled areas, not strokes
    const painting = image((x, y) => {
      const body = ((x - 128) / 34) ** 2 + ((y - 150) / 70) ** 2 < 1,
        head = ((x - 128) / 18) ** 2 + ((y - 68) / 18) ** 2 < 1;
      return body || head ? 55 + 20 * (x / S) : 205 + 35 * (y / S);
    });
    expect(looksLikeSketch(painting)).toBe(false);
  });

  it('stick figures are still line drawings, read into their poses', () => {
    for (const name of ['standing', 'kneeling', 'lunge', 'arms_up']) {
      const img = draw(POSES[name]);
      expect(looksLikeSketch(img), name).toBe(true);
      expect(readSketch(img), name).not.toBeNull();
    }
  });

  it('a drawing of a thing (a house: walls, roof, windows, door) is not read as a figure', () => {
    const house = lines([
      ...rect(60, 120, 196, 220),
      [50, 125, 128, 50],
      [128, 50, 206, 125],
      [50, 125, 206, 125],
      ...rect(80, 140, 110, 170),
      ...rect(146, 140, 176, 170),
      ...rect(115, 175, 141, 220),
      [20, 222, 236, 222],
    ]);
    expect(looksLikeSketch(house)).toBe(true); // it is a drawing…
    const read = readSketch(house);
    expect(read && describePose(read)[0], 'read as a pose').toBeNull(); // …but not of a person (it used to read as "kneeling")
  });
});

describe('words for a drawing searched by its look', () => {
  // what the model read in a line drawing of a house, and of a sword (one word per kind, best first)
  const house = ['cottage', 'stick figure', 'three-quarter view', 'trap'],
    sword = ['drawing sword', 'longsword', 'swordsman', 'battlefield'];
  it('leaves out words about the drawing itself (its pose and view), not what it shows', () => {
    expect(drawingWords(v, house, 'auto')).toEqual(['cottage', 'trap']);
    expect(drawingWords(v, sword, 'auto')).toEqual(['longsword', 'swordsman', 'battlefield']);
  });
  it('puts the kind of thing the mode asks for first', () => {
    expect(drawingWords(v, house, 'place')[0]).toBe('cottage');
    expect(drawingWords(v, house, 'prop')[0]).toBe('trap');
    expect(drawingWords(v, sword, 'prop')[0]).toBe('longsword');
    expect(drawingWords(v, sword, 'place')[0]).toBe('battlefield');
  });
});
