import { buildDataSet } from './engine/dataset';
import type { DataSet } from './engine/types';

const files = import.meta.glob(['../data/**/*.json', '!../data/_drafts/**'], { eager: true, import: 'default' });

let cached: DataSet | null = null;

export function loadData(): DataSet {
  if (cached) return cached;
  const byRel: Record<string, unknown> = {};
  for (const [path, json] of Object.entries(files)) byRel[path.replace(/^\.\.\/data\//, '')] = json;
  cached = buildDataSet(byRel);
  return cached;
}
