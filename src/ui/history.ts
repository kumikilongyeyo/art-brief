import type { Brief, DataSet } from '../engine/types';
import { h } from './dom';

export interface ListsHandlers {
  restore: (brief: Brief) => void;
  toggle: (which: 'history' | 'saved', open: boolean) => void;
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function list(items: Brief[], data: DataSet, hd: ListsHandlers, emptyText: string) {
  if (!items.length) return h('p', { class: 'empty' }, emptyText);
  return h(
    'ul',
    {},
    ...items.map((b) =>
      h(
        'li',
        {},
        h(
          'button',
          { type: 'button', onclick: () => hd.restore(b), 'aria-label': `Restore ${b.title}` },
          h('span', { class: 'item-title' }, b.title),
          h(
            'span',
            { class: 'item-meta' },
            `${data.categories[b.category]?.name ?? b.category} · ${data.themeById[b.theme]?.name ?? b.theme} · ${timeAgo(b.createdAt)}`,
          ),
        ),
      ),
    ),
  );
}

export function renderLists(
  history: Brief[],
  saved: Brief[],
  data: DataSet,
  open: { history: boolean; saved: boolean },
  hd: ListsHandlers,
): HTMLElement {
  const mk = (which: 'history' | 'saved', title: string, items: Brief[], empty: string) => {
    const d = h(
      'details',
      { open: open[which], id: `list-${which}` },
      h('summary', {}, `${title} (${items.length})`),
      list(items, data, hd, empty),
    );
    d.addEventListener('toggle', () => hd.toggle(which, d.open));
    return d;
  };
  return h(
    'section',
    { class: 'lists', 'aria-label': 'History and saved' },
    mk('history', 'History', history, 'Nothing yet — your last 100 generations appear here.'),
    mk('saved', 'Saved', saved, 'Tap Save on a card to keep it here.'),
  );
}
