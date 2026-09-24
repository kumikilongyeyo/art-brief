import type { Brief } from './engine/types';

/** Saved briefs organised into folders. Pure helpers; storage lives in storage.ts. */

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export type LibraryFilter = 'all' | 'unsorted' | string;

export const FOLDER_NAME_MAX = 40;

export function cleanFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX);
}

/** Add a folder; an existing folder with the same name (any case) is reused instead of duplicated. */
export function createFolder(folders: Folder[], name: string, id: string, now: number): { folders: Folder[]; folder: Folder | null } {
  const clean = cleanFolderName(name);
  if (!clean) return { folders, folder: null };
  const existing = folders.find((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (existing) return { folders, folder: existing };
  const folder = { id, name: clean, createdAt: now };
  return { folders: [...folders, folder], folder };
}

/** Rename; refused (unchanged) if empty or another folder already has that name. */
export function renameFolder(folders: Folder[], id: string, name: string): Folder[] {
  const clean = cleanFolderName(name);
  if (!clean || folders.some((f) => f.id !== id && f.name.toLowerCase() === clean.toLowerCase())) return folders;
  return folders.map((f) => (f.id === id ? { ...f, name: clean } : f));
}

/** Delete a folder; its briefs move to Unsorted (never deleted). */
export function deleteFolder(folders: Folder[], saved: Record<string, Brief>, id: string) {
  const next: Record<string, Brief> = {};
  for (const [k, b] of Object.entries(saved)) next[k] = b.folder === id ? { ...b, folder: undefined } : b;
  return { folders: folders.filter((f) => f.id !== id), saved: next };
}

export function moveBrief(saved: Record<string, Brief>, briefId: string, folderId: string | undefined): Record<string, Brief> {
  const b = saved[briefId];
  if (!b) return saved;
  return { ...saved, [briefId]: { ...b, folder: folderId || undefined } };
}

export function saveBrief(saved: Record<string, Brief>, brief: Brief, folderId: string | undefined, now: number): Record<string, Brief> {
  return { ...saved, [brief.id]: { ...brief, folder: folderId || undefined, savedAt: now } };
}

export function removeBrief(saved: Record<string, Brief>, briefId: string): Record<string, Brief> {
  const next = { ...saved };
  delete next[briefId];
  return next;
}

/** Folder ids that no longer exist count as Unsorted. */
export function folderOf(b: Brief, folders: Folder[]): string | undefined {
  return b.folder && folders.some((f) => f.id === b.folder) ? b.folder : undefined;
}

export function folderName(id: string | undefined, folders: Folder[]): string {
  return folders.find((f) => f.id === id)?.name ?? 'Unsorted';
}

export function filterSaved(saved: Record<string, Brief>, folders: Folder[], filter: LibraryFilter): Brief[] {
  return Object.values(saved)
    .filter((b) => filter === 'all' || (filter === 'unsorted' ? !folderOf(b, folders) : folderOf(b, folders) === filter))
    .sort((a, b) => (b.savedAt ?? b.createdAt ?? 0) - (a.savedAt ?? a.createdAt ?? 0));
}

export function folderCounts(saved: Record<string, Brief>, folders: Folder[]): Record<string, number> {
  const counts: Record<string, number> = { all: 0, unsorted: 0 };
  for (const f of folders) counts[f.id] = 0;
  for (const b of Object.values(saved)) {
    counts.all++;
    counts[folderOf(b, folders) ?? 'unsorted']++;
  }
  return counts;
}

/** A filter that still exists (a deleted folder falls back to All). */
export function validFilter(filter: LibraryFilter, folders: Folder[]): LibraryFilter {
  return filter === 'all' || filter === 'unsorted' || folders.some((f) => f.id === filter) ? filter : 'all';
}

/** Merge imported folders: same id or same name (any case) is the same folder. Returns id remapping for briefs. */
export function mergeFolders(current: Folder[], incoming: Folder[]): { folders: Folder[]; remap: Record<string, string> } {
  const folders = [...current];
  const remap: Record<string, string> = {};
  for (const f of incoming) {
    const name = cleanFolderName(f?.name ?? '');
    if (!f?.id || !name) continue;
    const match = folders.find((x) => x.id === f.id) ?? folders.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (match) remap[f.id] = match.id;
    else {
      folders.push({ id: f.id, name, createdAt: f.createdAt || 0 });
      remap[f.id] = f.id;
    }
  }
  return { folders, remap };
}
