import { rollFor } from '../engine/dice';
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
  rerollArt: (index: number) => void;
}

export interface CardOptions {
  index: number;
  saved: boolean;
  /** Folder name when saved, shown on the folder button. */
  folderName?: string;
  showChatGPT: boolean;
  /** D&D extras (stat line, dice rolls, DM notes). Off = art-first. */
  showDnd?: boolean;
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

/** Small "d100 · 37" chip: the table roll this line came from. */
function rollChip(brief: Brief, slot: SlotId, o: CardOptions): HTMLElement | null {
  const cat = o.data.categories[brief.category];
  const roll = cat && brief.fields[slot] ? rollFor(o.data, cat, slot, brief.fields[slot].entryId, brief.seed) : null;
  return roll ? h('span', { class: 'roll', title: `Rolled ${roll} on d100`, 'aria-label': `d100 roll ${roll}` }, String(roll)) : null;
}

/** How to draw it: shape language, focal point, light & value, camera. */
function artBlock(brief: Brief, o: CardOptions, hd: CardHandlers): HTMLElement | null {
  const a = brief.art;
  if (!a) return null;
  const row = (label: string, text: string | undefined) =>
    text ? h('div', { class: 'art-row' }, h('dt', {}, label), h('dd', {}, text)) : null;
  const valueLabel = brief.category === 'building' || brief.category === 'scene' ? 'Value' : 'Light & value';
  return h(
    'details',
    { class: 'art' },
    h(
      'summary',
      { class: 'art-summary' },
      h('span', { class: 'art-title' }, 'Technical direction'),
      h('span', { class: 'art-hint' }, 'shape · focal point · light · camera · deliverables'),
    ),
    h(
      'div',
      { class: 'art-body' },
      h(
        'dl',
        { class: 'art-lines' },
        row('Shape', a.shape),
        row('Focal point', `${a.focal}.`),
        row(valueLabel, a.light),
        row('Camera', a.camera),
      ),
      a.deliverable ? h('p', { class: 'deliverable' }, h('span', { class: 'deliverable-label' }, 'Deliverables'), a.deliverable) : null,
      a.note ? h('p', { class: 'ad-note' }, h('span', { class: 'ad-note-label' }, 'AD note'), `“${a.note}.”`) : null,
      o.sample
        ? null
        : h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              'aria-label': 'Reroll art direction',
              title: 'Another take on shape, light and camera',
              'data-focus': `art-reroll:${o.index}`,
              onclick: () => hd.rerollArt(o.index),
            },
            icon('reroll'),
            'Another take',
          ),
    ),
  );
}

/** D&D job-board lines under the story; the twist stays hidden until revealed. */
function hookCard(brief: Brief): HTMLElement | null {
  const l = brief.lore;
  if (!l || !(l.rumour || l.job || l.patron || l.reward || l.twist)) return null;
  const row = (label: string, text: string | undefined, cls = '') =>
    text ? h('div', { class: `hook-row ${cls}` }, h('dt', {}, label), h('dd', {}, text)) : null;
  return h(
    'details',
    { class: 'hook' },
    h('summary', {}, 'DM notes'),
    h(
      'dl',
      { class: 'hook-lines' },
      row('Rumour', l.rumour ? `“${l.rumour.replace(/\.$/, '')}”` : undefined, 'rumour'),
      row('Job', l.job),
      row('Patron', l.patron),
      row('Reward', l.reward),
    ),
    l.twist
      ? h(
          'details',
          { class: 'twist' },
          h('summary', {}, h('span', { class: 'twist-label' }, 'Twist'), h('span', { class: 'twist-hint' }, 'DM only — tap to reveal')),
          h('p', {}, l.twist),
        )
      : null,
  );
}

export function renderCard(brief: Brief, o: CardOptions, hd: CardHandlers): HTMLElement {
  const tpl = TEMPLATES[brief.category];
  const themeName = o.data.themeById[brief.theme]?.name ?? brief.theme;
  const card = h('article', { class: `card${o.sample ? ' sample' : ''}`, 'data-brief-id': brief.id, 'aria-label': brief.title });

  if (o.sample) card.append(h('span', { class: 'sample-tag' }, 'Sample — press Generate for your own'));
  card.append(
    h(
      'p',
      { class: 'overline' },
      `${brief.art?.purpose ?? 'Art brief'} · ${o.data.categories[brief.category]?.name ?? brief.category} · #${brief.base}-${brief.index + 1}`,
    ),
  );

  const titleLocked = isLocked(brief, tpl.titleLock);
  card.append(
    h(
      'div',
      { class: `row title-row${titleLocked ? ' locked' : ''}` },
      h(
        'div',
        { class: 'title-block' },
        h('h2', { class: 'title' }, brief.title),
        brief.stat && o.showDnd ? h('p', { class: 'stat' }, icon('d20'), brief.stat) : null,
      ),
      o.sample ? null : lineActions(brief, 'Title', tpl.titleLock, tpl.titleReroll, o, hd),
    ),
  );

  if (brief.art?.ask) card.append(h('p', { class: 'ask-line' }, h('span', { class: 'ask-label' }, 'The ask'), `${brief.art.ask}.`));

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
        h('dt', {}, line.label, o.showDnd ? rollChip(brief, line.slot, o) : null),
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
          h('h3', { class: 'lore-title' }, 'Lore', brief.lore.spine ? h('span', { class: 'spine-tag' }, brief.lore.spine) : null),
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
        brief.lore.moment ? h('p', { class: 'moment' }, h('span', { class: 'moment-label' }, 'Moment to paint'), brief.lore.moment) : null,
        o.showDnd ? hookCard(brief) : null,
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

  // Technical direction lives in a fold so the card leads with the subject and its story.
  const art = artBlock(brief, o, hd);
  if (art) card.append(art);

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
