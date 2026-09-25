import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completions, corrected, makePlan, resolveQuery, segment, vocabFrom, type VocabFile } from '../../src/refs/vocab';
import { describePose, fromIndex, looksLikeSketch, poseSimilarity, readSketch, type Skeleton } from '../../src/refs/pose';

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
  // typos the TYPO table doesn't list: these go through the edit-distance repair
  it.each([
    ['knihgt', 'knight'],
    ['sheld', 'shield'],
    ['lantren', 'lantern'],
    ['mountian', 'mountain'],
    ['spaer', 'spear'],
    ['draogn', 'dragon'],
    ['swiming', 'swimming'],
    // a vowel that sounds right, a letter typed twice
    ['dragen', 'dragon'],
    ['skeliton', 'skeleton'],
    ['wizerd', 'wizard'],
    ['fightting', 'fighting'],
    ['bootss', 'boots'],
  ])('fixes %s → %s by distance', (typed, want) => {
    expect(resolveQuery(v, typed)).toBe(want);
  });
  // real words one letter from a vocabulary word, and the Narrow chips' own words
  it.each([
    'dragon fangs',
    'rearing horse',
    'knight cape flowing',
    'long flowing hair',
    'growling wolf',
    'gliding owl',
    'stabbing',
    'misty forest',
    'hazy',
    'two-handed mid-swing from below back view at night',
    'backlit moody painterly high contrast cold palette',
    'at dusk in fog interior aerial view ruined',
    'ornate worn close-up on display engraved',
    'in flight roaring side view in water',
    // real words the vocabulary lacks, an edit from one it has
    'rose thorn',
    'arid desert',
    'grim reaper',
    'scarred face',
    'dragon chin',
    'knight stab',
    'wolf fang',
    'horse hoof',
    'bride veil',
    'eagle soar',
    'mop',
  ])('searches %s as typed', (q) => {
    expect(resolveQuery(v, q)).toBe(q);
  });
  it('searches plurals as typed, and still finds their words', () => {
    expect(resolveQuery(v, 'wolfs howling')).toBe('wolfs howling');
    expect(segment(v, 'wolfs howling')).toContain('wolf howling');
    expect(segment(v, 'flowing robes')).toContain('robe');
  });
  it('folds accents and keeps other scripts', () => {
    expect(resolveQuery(v, 'Pokémon trainer')).toBe('pokemon trainer');
    expect(resolveQuery(v, 'café interior')).toBe('cafe interior');
    expect(resolveQuery(v, 'château fort')).toBe('chateau fort');
    expect(corrected('château fort', resolveQuery(v, 'château fort'))).toBe(false);
    expect(completions(v, 'Pokém').some((k) => k.includes('monk'))).toBe(false);
    for (const q of ['ドラゴン', '龙', 'дракон', 'ड्रैगन']) expect(resolveQuery(v, q)).toBe(q);
    expect(resolveQuery(v, 'ドラゴン knight')).toBe('ドラゴン knight');
    expect(resolveQuery(v, '🐉🗡️')).toBe(''); // nothing to search: the page says so
  });
  it('leaves correct words and words it doesn’t know alone', () => {
    expect(resolveQuery(v, 'knight holding sword')).toBe('knight holding sword');
    expect(resolveQuery(v, 'glorptastic zweihander')).toBe('glorptastic zweihander');
    for (const q of ['totoro', 'geralt of rivia', 'hobbit house', 'bikini', 'cyberpunk city', 'umbrella in the rain']) expect(resolveQuery(v, q)).toBe(q);
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

import { draw, POSES } from './refs-draw';

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
  it('tells different poses apart and keeps mirrored ones together', () => {
    const names = Object.keys(POSES);
    for (const a of names) {
      expect(poseSimilarity(readSketch(draw(POSES[a], true))!, read[a]), `${a} vs its mirror`).toBeGreaterThan(0.8);
      for (const b of names) if (a !== b) expect(poseSimilarity(read[a], read[b]), `${a} vs ${b}`).toBeLessThan(0.7);
    }
  });
  it.each(Object.keys(POSES))('reads %s when its strokes do not quite touch', (name) => {
    const s = readSketch(draw(POSES[name], false, 8));
    expect(s).not.toBeNull();
    for (const j of ['elbowA', 'wristA', 'elbowB', 'wristB'] as const) expect(s![j].c, `${name} ${j}`).toBeGreaterThan(0);
    expect(poseSimilarity(s!, read[name]), name).toBeGreaterThan(0.85);
  });
  it('a sketch with an arm left out still matches its pose', () => {
    const s = readSketch(draw(POSES.lunge))!;
    const oneArm = { ...s, elbowB: { ...s.neck, c: 0 }, wristB: { ...s.neck, c: 0 } };
    expect(poseSimilarity(oneArm, s)).toBeGreaterThan(0.9);
  });
  it('reads a drawing photographed on grey, unevenly lit paper', () => {
    const img = draw(POSES.arms_up);
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, shade = 0.55 + 0.35 * (x / img.width); // shadow across the page
        for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * shade * (c === 2 ? 0.9 : 1));
      }
    expect(looksLikeSketch(img)).toBe(true);
    const s = readSketch(img)!;
    expect(s).not.toBeNull();
    expect(poseSimilarity(s, read.arms_up)).toBeGreaterThan(0.8);
  });
  it('reads the pose index rows the build writes', () => {
    // one row: 17 joints [x, y, conf] u8 + aspect × 64, from a skeleton standing upright
    const b = new Uint8Array(52);
    const put = (j: number, x: number, y: number) => b.set([x * 255, y * 255, 230], j * 3);
    put(0, 0.5, 0.1); put(5, 0.45, 0.2); put(6, 0.55, 0.2); put(7, 0.42, 0.35); put(8, 0.58, 0.35); put(9, 0.41, 0.5); put(10, 0.59, 0.5);
    put(11, 0.46, 0.55); put(12, 0.54, 0.55); put(13, 0.46, 0.75); put(14, 0.54, 0.75); put(15, 0.46, 0.95); put(16, 0.54, 0.95);
    b[51] = 64;
    const s = fromIndex(b, 0)!;
    expect(s).not.toBeNull();
    expect(poseSimilarity(read.standing, s)).toBeGreaterThan(poseSimilarity(read.arms_up, s));
    expect(fromIndex(new Uint8Array(52), 0)).toBeNull();
  });
  it('describes poses in search words', () => {
    expect(describePose(read.arms_up)[0]).toBe('arms raised');
    expect(describePose(read.standing)[0]).toBe('standing');
    expect(describePose(read.kneeling)[0]).toBe('kneeling');
  });
});
