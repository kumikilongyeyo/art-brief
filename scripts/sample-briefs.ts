/** Print sample briefs for eyeballing content quality. Usage: npx tsx scripts/sample-briefs.ts [category] [count] */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataSet } from '../src/engine/dataset';
import { generateBatch } from '../src/engine/generate';
import { seedFromString } from '../src/engine/rng';
import { countWords } from '../src/engine/templates';
import { CATEGORY_IDS, WEIRDNESS, type CategoryId } from '../src/engine/types';

const DATA = join(fileURLToPath(import.meta.url), '..', '..', 'data');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.json') ? [join(d, f)] : []));
const files: Record<string, unknown> = {};
for (const p of walk(DATA)) files[relative(DATA, p)] = JSON.parse(readFileSync(p, 'utf8'));
const data = buildDataSet(files);

const only = process.argv[2] as CategoryId | undefined;
const n = Number(process.argv[3] ?? 1);
for (const c of only ? [only] : CATEGORY_IDS) {
  for (const w of WEIRDNESS) {
    for (let i = 0; i < n; i++) {
      const base = seedFromString(`${Date.now()}-${c}-${w}-${i}`);
      const b = generateBatch(data, { category: c, themeChoice: 'any', weirdness: w, count: 1, base, uniqueFrequency: 'sometimes' })[0];
      console.log(`[${c} · ${w} · ${b.theme} · ${countWords(b.title, b.lines)} words]\n${b.plainText}\n`);
    }
  }
}
