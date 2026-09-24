/** Story length stats. Usage: npx tsx scripts/lore-stats.ts character,prop */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildDataSet } from '../src/engine/dataset';
import { generateBatch } from '../src/engine/generate';
import { loreWords } from '../src/engine/lore';
import { seedFromString } from '../src/engine/rng';
import type { CategoryId } from '../src/engine/types';
const D = new URL('../data', import.meta.url).pathname;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.json') ? [join(d, f)] : []));
const files: Record<string, unknown> = {};
for (const p of walk(D)) files[relative(D, p)] = JSON.parse(readFileSync(p, 'utf8'));
const data = buildDataSet(files);
const cats = (process.argv[2] ?? 'prop').split(',') as CategoryId[];
for (const c of cats) {
  const ws: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const b = generateBatch(data, {
      category: c,
      themeChoice: 'any',
      weirdness: (['grounded', 'mixed', 'wild'] as const)[i % 3],
      count: 1,
      base: seedFromString(`ls-${c}-${i}`),
      uniqueFrequency: 'sometimes',
      lore: true,
    })[0];
    ws.push(loreWords(b.lore!.text));
  }
  const over = ws.filter((w) => w > 80).length,
    under = ws.filter((w) => w < 50).length;
  ws.sort((a, b) => a - b);
  console.log(c, 'min', ws[0], 'median', ws[750], 'max', ws.at(-1), 'over80', over, 'under50', under);
}
