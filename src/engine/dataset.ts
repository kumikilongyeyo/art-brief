import type { CategoryDef, CategoryId, Culture, DataSet, Palette, Table, Theme } from './types';

/** Build a DataSet from a map of data-relative paths (e.g. "character/look.json") to parsed JSON. */
export function buildDataSet(files: Record<string, unknown>): DataSet {
  const tags = new Set<string>();
  let themes: Theme[] = [];
  let palettes: Palette[] = [];
  let version = '0';
  const categories = {} as Record<CategoryId, CategoryDef>;
  const tables: Record<string, Table> = {};
  const cultures: Culture[] = [];

  for (const [path, json] of Object.entries(files)) {
    const j = json as Record<string, unknown>;
    if (path === 'tags.json') {
      for (const list of Object.values(j.groups as Record<string, string[]>)) list.forEach((t) => tags.add(t));
    } else if (path === 'themes.json') {
      themes = j.themes as Theme[];
    } else if (path === 'palettes.json') {
      palettes = j.palettes as Palette[];
    } else if (path === 'meta.json') {
      version = j.dataVersion as string;
    } else if (path.startsWith('categories/')) {
      const c = j as unknown as CategoryDef;
      categories[c.id] = c;
    } else if (path.startsWith('names/') && !path.startsWith('names/words/')) {
      cultures.push(j as unknown as Culture);
    } else if (path.startsWith('_drafts/')) {
      continue;
    } else {
      const t = j as unknown as Table;
      tables[t.id] = t;
    }
  }
  cultures.sort((a, b) => a.id.localeCompare(b.id));
  const themeById = Object.fromEntries(themes.map((t) => [t.id, t]));
  return { version, tags, themes, themeById, categories, tables, palettes, cultures };
}
