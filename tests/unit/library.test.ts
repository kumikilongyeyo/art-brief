import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanFolderName,
  createFolder,
  deleteFolder,
  filterSaved,
  folderCounts,
  folderOf,
  mergeFolders,
  moveBrief,
  removeBrief,
  renameFolder,
  saveBrief,
  validFilter,
  type Folder,
} from '../../src/library';
import { exportSaved, importSaved, loadFolders, resetStorageProbe, saveFolders } from '../../src/storage';
import type { Brief } from '../../src/engine/types';
import { one, seeds } from './helpers';

const briefs = seeds(6, 'lib').map((s, i) => one((['character', 'prop', 'creature'] as const)[i % 3], s));

describe('folders', () => {
  it('create reuses an existing name (any case) and rejects empty names', () => {
    let f: Folder[] = [];
    const a = createFolder(f, '  Villains  ', 'f1', 1);
    f = a.folders;
    expect(a.folder).toEqual({ id: 'f1', name: 'Villains', createdAt: 1 });
    const b = createFolder(f, 'villains', 'f2', 2);
    expect(b.folder!.id).toBe('f1');
    expect(b.folders).toHaveLength(1);
    expect(createFolder(f, '   ', 'f3', 3).folder).toBeNull();
    expect(cleanFolderName('x'.repeat(80))).toHaveLength(40);
  });

  it('rename refuses duplicates and empty names', () => {
    const f: Folder[] = [
      { id: 'a', name: 'Heroes', createdAt: 0 },
      { id: 'b', name: 'Villains', createdAt: 0 },
    ];
    expect(renameFolder(f, 'a', 'Allies')[0].name).toBe('Allies');
    expect(renameFolder(f, 'a', 'villains')).toBe(f);
    expect(renameFolder(f, 'a', '  ')).toBe(f);
  });

  it('deleting a folder moves its briefs to Unsorted, never deletes them', () => {
    const f: Folder[] = [{ id: 'a', name: 'Heroes', createdAt: 0 }];
    let saved: Record<string, Brief> = {};
    saved = saveBrief(saved, briefs[0], 'a', 1);
    saved = saveBrief(saved, briefs[1], undefined, 2);
    const r = deleteFolder(f, saved, 'a');
    expect(r.folders).toEqual([]);
    expect(Object.keys(r.saved)).toHaveLength(2);
    expect(r.saved[briefs[0].id].folder).toBeUndefined();
  });

  it('save / move / remove / filter / counts', () => {
    const f: Folder[] = [{ id: 'a', name: 'Heroes', createdAt: 0 }];
    let saved: Record<string, Brief> = {};
    briefs.forEach((b, i) => (saved = saveBrief(saved, b, i < 2 ? 'a' : undefined, i)));
    expect(folderCounts(saved, f)).toEqual({ all: 6, unsorted: 4, a: 2 });
    saved = moveBrief(saved, briefs[2].id, 'a');
    expect(filterSaved(saved, f, 'a').map((b) => b.id)).toEqual([briefs[2].id, briefs[1].id, briefs[0].id]); // newest saved first
    saved = removeBrief(saved, briefs[5].id);
    expect(filterSaved(saved, f, 'all')).toHaveLength(5);
    expect(filterSaved(saved, f, 'unsorted')).toHaveLength(2);
    // A brief pointing at a folder that no longer exists counts as Unsorted.
    expect(folderOf({ ...briefs[0], folder: 'gone' }, f)).toBeUndefined();
    expect(validFilter('gone', f)).toBe('all');
    expect(validFilter('a', f)).toBe('a');
  });

  it('merge maps imported folders by id or name', () => {
    const current: Folder[] = [{ id: 'a', name: 'Heroes', createdAt: 0 }];
    const r = mergeFolders(current, [
      { id: 'x', name: 'heroes', createdAt: 5 },
      { id: 'y', name: 'Places', createdAt: 5 },
      { id: 'a', name: 'Heroes', createdAt: 0 },
    ]);
    expect(r.folders.map((f) => f.name)).toEqual(['Heroes', 'Places']);
    expect(r.remap).toEqual({ x: 'a', y: 'y', a: 'a' });
  });
});

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage?: unknown };

describe('folder storage and export/import', () => {
  beforeEach(() => {
    g.localStorage = new MemStorage();
    resetStorageProbe();
  });
  afterEach(() => {
    delete g.localStorage;
    resetStorageProbe();
  });

  it('folders persist', () => {
    saveFolders([{ id: 'a', name: 'Heroes', createdAt: 1 }]);
    expect(loadFolders()).toEqual([{ id: 'a', name: 'Heroes', createdAt: 1 }]);
  });

  it('export carries folders; import into another device keeps the organisation, merges by name, no duplicates', () => {
    const folders: Folder[] = [{ id: 'a', name: 'Heroes', createdAt: 1 }];
    let saved: Record<string, Brief> = {};
    saved = saveBrief(saved, briefs[0], 'a', 1);
    saved = saveBrief(saved, briefs[1], undefined, 2);
    const file = exportSaved(saved, folders);
    // Other device already has its own "heroes" folder with a different id.
    const other: Folder[] = [{ id: 'z', name: 'heroes', createdAt: 9 }];
    const r = importSaved({}, file, other);
    expect(r.added).toBe(2);
    expect(r.folders).toEqual(other);
    expect(r.saved[briefs[0].id].folder).toBe('z');
    expect(r.saved[briefs[1].id].folder).toBeUndefined();
    expect(importSaved(r.saved, file, r.folders).added).toBe(0);
  });

  it('older exports without folders still import', () => {
    const r = importSaved({}, JSON.stringify({ saved: [briefs[0]] }), []);
    expect(r.added).toBe(1);
    expect(r.folders).toEqual([]);
  });
});
