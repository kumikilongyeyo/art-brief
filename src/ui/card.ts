import { TEMPLATES } from '../engine/templates';
import type { Brief, DataSet, SlotId } from '../engine/types';
import { h, icon, inkFor } from './dom';

export interface CardHandlers {
  toggleLock: (index: number, slots: SlotId[]) => void;
  reroll: (index: number, slots: SlotId[]) => void;
  copy: (index: number) => void;
  copyChat: (index: number) => void;
  save: (index: number) => void;
  moveFolder: (index: number, anchor: HTMLElement) => void;
  link: (index: number) => void;
  swatch: (hex: string) => void;
  addLore: (index: number) => void;
  rerollLore: (index: number) => void;
  hideLore: (index: number) => void;
  refineLore: (index: number) => void;
}

export interface CardOptions {
  index: number;
  saved: boolean;
  /** Folder name when saved, shown on the folder button. */
  folderName?: string;
  showChatGPT: boolean;
  sample?: boolean;
  data: DataSet;
}

function isLocked(brief: Brief, slots: SlotId[]): boolean {
  return slots.length > 0 && slots.every((s) => brief.fields[s]?.locked);
}

function lineActions(brief: Brief, label: string, lockSlots: SlotId[], rerollSlots: SlotId[], o: CardOptions, hd: CardHandlers) {
  const locked = isLocked(brief, lockSlots);
  const key = lockSlots.join('+');
  return h(
    'div',
    { class: 'actions' },
    h(
      'button',
      {
        class: 'mini',
        type: 'button',
        'aria-label': `${locked ? 'Unlock' : 'Lock'} ${label}`,
        'aria-pressed': String(locked),
        title: locked ? 'Unlock' : 'Lock',
        'data-focus': `lock:${o.index}:${key}`,
        onclick: () => hd.toggleLock(o.index, lockSlots),
      },
      icon(locked ? 'lock' : 'unlock', locked),
    ),
    h(
      'button',
      {
        class: 'mini',
        type: 'button',
        'aria-label': `Reroll ${label}`,
        title: locked ? 'Unlock to reroll' : 'Reroll',
        disabled: rerollSlots.every((s) => brief.fields[s]?.locked),
        'data-focus': `reroll:${o.index}:${key}`,
        onclick: () => hd.reroll(o.index, rerollSlots),
      },
      icon('reroll'),
    ),
  );
}

export function renderCard(brief: Brief, o: CardOptions, hd: CardHandlers): HTMLElement {
  const tpl = TEMPLATES[brief.category];
  const themeName = o.data.themeById[brief.theme]?.name ?? brief.theme;
  const card = h('article', { class: `card${o.sample ? ' sample' : ''}`, 'data-brief-id': brief.id, 'aria-label': brief.title });

  if (o.sample) card.append(h('span', { class: 'sample-tag' }, 'Sample — press Generate for your own'));

  const titleLocked = isLocked(brief, tpl.titleLock);
  card.append(
    h(
      'div',
      { class: `row title-row${titleLocked ? ' locked' : ''}` },
      h('h2', { class: 'title' }, brief.title),
      o.sample ? null : lineActions(brief, 'Title', tpl.titleLock, tpl.titleReroll, o, hd),
    ),
  );

  const dl = h('dl', { class: 'lines' });
  for (const line of brief.lines) {
    const slots = line.slots ?? [line.slot];
    const locked = isLocked(brief, slots);
    let value: Node;
    if (line.slot === 'palette') {
      value = h(
        'span',
        { class: 'swatches' },
        ...brief.palette.hex.map((hex) =>
          h(
            'button',
            {
              class: 'swatch',
              type: 'button',
              style: `background:${hex};color:${inkFor(hex)}`,
              'aria-label': `Copy ${hex}`,
              title: `Copy ${hex}`,
              onclick: () => hd.swatch(hex),
            },
            hex.toUpperCase(),
          ),
        ),
        h('span', { class: 'palette-name' }, brief.palette.name),
      );
    } else {
      value = document.createTextNode(line.text);
    }
    dl.append(
      h(
        'div',
        { class: `row line${locked ? ' locked' : ''}`, 'data-slot': line.slot },
        h('dt', {}, line.label),
        h('dd', {}, h('span', { class: 'value' }, value), o.sample ? null : lineActions(brief, line.label, slots, slots, o, hd)),
      ),
    );
  }
  card.append(dl);

  if (brief.lore?.text) {
    card.append(
      h(
        'section',
        { class: 'lore', 'aria-label': 'Lore' },
        h(
          'div',
          { class: 'lore-head' },
          h('h3', { class: 'lore-title' }, 'Lore'),
          o.sample
            ? null
            : h(
                'div',
                { class: 'lore-actions' },
                h(
                  'button',
                  {
                    class: 'mini',
                    type: 'button',
                    'aria-label': 'Reroll lore',
                    title: 'Tell it differently',
                    'data-focus': `lore-reroll:${o.index}`,
                    onclick: () => hd.rerollLore(o.index),
                  },
                  icon('reroll'),
                ),
                h(
                  'button',
                  { class: 'mini', type: 'button', 'aria-label': 'Hide lore', title: 'Hide lore', onclick: () => hd.hideLore(o.index) },
                  icon('close'),
                ),
              ),
        ),
        h('p', { class: 'lore-text' }, brief.lore.text),
        o.sample
          ? null
          : h(
              'button',
              { class: 'btn btn-small', type: 'button', 'data-focus': `lore-refine:${o.index}`, onclick: () => hd.refineLore(o.index) },
              icon('chat'),
              'Refine story in ChatGPT',
            ),
      ),
    );
  }

  if (!o.sample) {
    card.append(
      h(
        'div',
        { class: 'card-foot' },
        h(
          'button',
          { class: 'btn', type: 'button', 'data-focus': `copy:${o.index}`, onclick: () => hd.copy(o.index) },
          icon('copy'),
          'Copy',
        ),
        o.showChatGPT
          ? h(
              'button',
              {
                class: 'btn',
                type: 'button',
                'data-action': 'copy-chat',
                'data-focus': `chat:${o.index}`,
                onclick: () => hd.copyChat(o.index),
              },
              icon('chat'),
              'Copy for ChatGPT',
            )
          : null,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            'aria-pressed': String(o.saved),
            'aria-label': o.saved ? 'Remove from saved' : 'Save',
            'data-focus': `save:${o.index}`,
            onclick: () => hd.save(o.index),
          },
          icon('star', o.saved),
          o.saved ? 'Saved' : 'Save',
        ),
        o.saved
          ? h(
              'button',
              {
                class: 'btn btn-folder',
                type: 'button',
                'aria-label': `Move to folder (now: ${o.folderName ?? 'Unsorted'})`,
                title: 'Move to folder',
                'aria-haspopup': 'menu',
                'aria-expanded': 'false',
                'data-focus': `folder:${o.index}`,
                onclick: (e: Event) => hd.moveFolder(o.index, e.currentTarget as HTMLElement),
              },
              icon('folder'),
              h('span', { class: 'btn-folder-name' }, o.folderName ?? 'Unsorted'),
              icon('chevron'),
            )
          : null,
        h(
          'button',
          { class: 'btn', type: 'button', 'data-focus': `link:${o.index}`, onclick: () => hd.link(o.index) },
          icon('link'),
          'Link',
        ),
        brief.lore
          ? null
          : h(
              'button',
              { class: 'btn', type: 'button', 'data-focus': `lore-add:${o.index}`, onclick: () => hd.addLore(o.index) },
              icon('book'),
              'Add lore',
            ),
        h('span', { class: 'meta' }, `${themeName} · ${brief.weirdness} · ${brief.seed}`),
      ),
    );
  }
  return card;
}
