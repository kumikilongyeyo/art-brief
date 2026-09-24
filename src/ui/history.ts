import type { Brief, DataSet } from '../engine/types';
import { filterSaved, folderCounts, folderName, folderOf, type Folder, type LibraryFilter } from '../library';
import { h, icon } from './dom';

export interface ListsHandlers {
  restore: (brief: Brief) => void;
  toggle: (which: 'history' | 'saved', open: boolean) => void;
  // history
  toggleSave: (brief: Brief) => void;
  removeHistory: (brief: Brief) => void;
  clearHistory: () => void;
  // saved library
  setFilter: (filter: LibraryFilter) => void;
  moveMenu: (brief: Brief, anchor: HTMLElement) => void;
  removeSaved: (brief: Brief) => void;
  moveTo: (briefId: string, folderId: string | undefined) => void;
  createFolder: (name: string) => string | null;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
}

export interface ListsState {
  history: Brief[];
  saved: Record<string, Brief>;
  folders: Folder[];
  filter: LibraryFilter;
  open: { history: boolean; saved: boolean };
  /** Chip being renamed, or 'new' while typing a new folder name. */
  editing: string | null;
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

const iconBtn = (name: string, label: string, onclick: (e: Event) => void, extra: Record<string, string | boolean> = {}) =>
  h(
    'button',
    { class: 'mini', type: 'button', 'aria-label': label, title: label, onclick, ...extra },
    icon(name, extra['data-filled'] === 'true'),
  );

function itemMain(b: Brief, data: DataSet, hd: ListsHandlers, extraMeta = '') {
  const meta = [
    data.categories[b.category]?.name ?? b.category,
    data.themeById[b.theme]?.name ?? b.theme,
    extraMeta,
    timeAgo(b.savedAt ?? b.createdAt),
  ]
    .filter(Boolean)
    .join(' · ');
  return h(
    'button',
    { class: 'item-main', type: 'button', onclick: () => hd.restore(b), 'aria-label': `Open ${b.title}` },
    h('span', { class: 'item-title' }, b.title),
    h('span', { class: 'item-meta' }, meta),
  );
}

function historySection(st: ListsState, data: DataSet, hd: ListsHandlers) {
  const body = st.history.length
    ? [
        h(
          'div',
          { class: 'list-tools' },
          h('span', { class: 'list-note' }, 'Saved briefs are kept when you clear history.'),
          h(
            'button',
            { class: 'btn btn-small', type: 'button', 'data-focus': 'clear-history', onclick: () => hd.clearHistory() },
            icon('trash'),
            'Clear history',
          ),
        ),
        h(
          'ul',
          { class: 'items' },
          ...st.history.map((b) => {
            const isSaved = !!st.saved[b.id];
            return h(
              'li',
              { class: 'item' },
              itemMain(b, data, hd),
              h(
                'div',
                { class: 'item-actions' },
                iconBtn('star', isSaved ? 'Remove from saved' : 'Save', () => hd.toggleSave(b), {
                  'aria-pressed': String(isSaved),
                  'data-filled': String(isSaved),
                  'data-focus': `hsave:${b.id}`,
                }),
                iconBtn('close', 'Remove from history', () => hd.removeHistory(b), { 'data-focus': `hremove:${b.id}` }),
              ),
            );
          }),
        ),
      ]
    : [h('p', { class: 'empty' }, 'Nothing yet — your last 100 generations appear here.')];
  const d = h('details', { open: st.open.history, id: 'list-history' }, h('summary', {}, `History (${st.history.length})`), ...body);
  d.addEventListener('toggle', () => hd.toggle('history', d.open));
  return d;
}

function inlineName(initial: string, label: string, commit: (v: string) => void, cancel: () => void) {
  const input = h('input', { class: 'chip-input', type: 'text', maxlength: '40', placeholder: 'Folder name', 'aria-label': label });
  input.value = initial;
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    if (ok && input.value.trim()) commit(input.value);
    else cancel();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function savedSection(st: ListsState, data: DataSet, hd: ListsHandlers, setEditing: (v: string | null) => void) {
  const counts = folderCounts(st.saved, st.folders);
  const chip = (filter: LibraryFilter, label: string, droppable: boolean) => {
    const el = h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(st.filter === filter),
        'data-filter': filter,
        'data-focus': `chip:${filter}`,
        onclick: () => hd.setFilter(filter),
      },
      filter === 'all' ? null : icon('folder'),
      h('span', { class: 'chip-label' }, label),
      h('span', { class: 'chip-count' }, String(counts[filter] ?? 0)),
    );
    if (droppable) {
      // Desktop: drop a saved brief onto a folder chip to file it.
      el.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('text/x-brief')) {
          e.preventDefault();
          el.classList.add('drop');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        const id = e.dataTransfer?.getData('text/x-brief');
        if (id) hd.moveTo(id, filter === 'unsorted' ? undefined : filter);
      });
    }
    return el;
  };

  const chips: HTMLElement[] = [chip('all', 'All', false), chip('unsorted', 'Unsorted', true)];
  for (const f of st.folders) {
    chips.push(
      st.editing === f.id
        ? inlineName(
            f.name,
            'Rename folder',
            (v) => {
              setEditing(null);
              hd.renameFolder(f.id, v);
            },
            () => setEditing(null),
          )
        : chip(f.id, f.name, true),
    );
  }
  chips.push(
    st.editing === 'new'
      ? inlineName(
          '',
          'New folder name',
          (v) => {
            setEditing(null);
            const id = hd.createFolder(v);
            if (id) hd.setFilter(id);
          },
          () => setEditing(null),
        )
      : h(
          'button',
          {
            class: 'chip chip-add',
            type: 'button',
            'aria-label': 'New folder',
            'data-focus': 'chip:new',
            onclick: () => setEditing('new'),
          },
          icon('plus'),
          h('span', { class: 'chip-label' }, 'Folder'),
        ),
  );

  const current = st.folders.find((f) => f.id === st.filter);
  const tools = current
    ? h(
        'div',
        { class: 'folder-tools' },
        h('span', { class: 'folder-current' }, icon('folder'), current.name),
        iconBtn('pencil', `Rename folder ${current.name}`, () => setEditing(current.id), { 'data-focus': 'rename-folder' }),
        iconBtn('trash', `Delete folder ${current.name}`, () => hd.deleteFolder(current.id), { 'data-focus': 'delete-folder' }),
      )
    : null;

  const items = filterSaved(st.saved, st.folders, st.filter);
  const empty =
    counts.all === 0
      ? 'No saved briefs yet — tap ☆ on a card or in History.'
      : st.filter === 'all'
        ? ''
        : 'Nothing in here yet — use the folder button on a brief, or drag one onto this chip.';
  const list = items.length
    ? h(
        'ul',
        { class: 'items' },
        ...items.map((b) => {
          const fid = folderOf(b, st.folders);
          const li = h(
            'li',
            { class: 'item', draggable: 'true' },
            itemMain(b, data, hd, st.filter === 'all' ? folderName(fid, st.folders) : ''),
            h(
              'div',
              { class: 'item-actions' },
              iconBtn(
                'folder',
                `Move to folder (now: ${folderName(fid, st.folders)})`,
                (e) => hd.moveMenu(b, e.currentTarget as HTMLElement),
                {
                  'aria-haspopup': 'menu',
                  'aria-expanded': 'false',
                  'data-focus': `smove:${b.id}`,
                },
              ),
              iconBtn('trash', 'Remove from saved', () => hd.removeSaved(b), { 'data-focus': `sremove:${b.id}` }),
            ),
          );
          li.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('text/x-brief', b.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            li.classList.add('dragging');
          });
          li.addEventListener('dragend', () => li.classList.remove('dragging'));
          return li;
        }),
      )
    : h('p', { class: 'empty' }, empty);

  const d = h(
    'details',
    { open: st.open.saved, id: 'list-saved' },
    h('summary', {}, `Saved (${counts.all})`),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Folders' }, ...chips),
    tools,
    list,
  );
  d.addEventListener('toggle', () => hd.toggle('saved', d.open));
  return d;
}

export function renderLists(st: ListsState, data: DataSet, hd: ListsHandlers, setEditing: (v: string | null) => void): HTMLElement {
  return h(
    'section',
    { class: 'lists', 'aria-label': 'History and saved' },
    historySection(st, data, hd),
    savedSection(st, data, hd, setEditing),
  );
}
