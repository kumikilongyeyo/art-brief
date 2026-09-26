import { rollFor } from '../engine/dice';
import { summaryNote } from '../engine/note';
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
  /** Remember which sections a card has open, so re-renders keep them. */
  setOpen: (index: number, section: CardSection, open: boolean) => void;
}

export type CardSection = 'details' | 'story' | 'direction';

export interface CardOptions {
  index: number;
  saved: boolean;
  /** Folder name when saved, shown on the folder button. */
  folderName?: string;
  showChatGPT: boolean;
  /** D&D extras (stat line, dice rolls, DM notes). Off = art-first. */
  showDnd?: boolean;
  sample?: boolean;
  /** Sections to show open (default: none — the card leads with its summary). */
  open?: CardSection[];
  data: DataSet;
  /** The reference board (src/refs/board.ts), under the palette. */
  board?: HTMLElement;
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
function directionPanel(brief: Brief, o: CardOptions, hd: CardHandlers): HTMLElement[] {
  const a = brief.art;
  if (!a) return [h('p', { class: 'empty-tab' }, 'No direction for this brief.')];
  const row = (label: string, text: string | undefined) =>
    text ? h('div', { class: 'art-row' }, h('dt', {}, label), h('dd', {}, text)) : null;
  const valueLabel = brief.category === 'building' || brief.category === 'scene' ? 'Value' : 'Light & value';
  const out: (HTMLElement | null)[] = [
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
  ];
  return out.filter((x): x is HTMLElement => !!x);
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

function swatches(brief: Brief, hd: CardHandlers): HTMLElement {
  return h(
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
}

/** Palette as small round swatches (click to copy a hex) plus its name. */
function paletteDots(brief: Brief, hd: CardHandlers): HTMLElement {
  return h(
    'div',
    { class: 'pal-dots' },
    ...brief.palette.hex.map((hex) =>
      h('button', {
        class: 'dot',
        type: 'button',
        style: `background:${hex}`,
        'aria-label': `Copy ${hex}`,
        title: `Copy ${hex}`,
        onclick: () => hd.swatch(hex),
      }),
    ),
    h('span', { class: 'palette-name' }, brief.palette.name),
  );
}

function iconButton(label: string, name: string, onclick: (e: Event) => void, extra: Record<string, string> = {}, filled = false) {
  return h('button', { class: 'ib', type: 'button', 'aria-label': label, title: label, onclick, ...extra }, icon(name, filled));
}

/**
 * "Read it like a note": job chips, the name, a short written summary, palette dots and the moment to
 * paint — then three collapsed rows (Every detail · Story · Direction) for everything else.
 */
export function renderCard(brief: Brief, o: CardOptions, hd: CardHandlers): HTMLElement {
  const tpl = TEMPLATES[brief.category];
  const themeName = o.data.themeById[brief.theme]?.name ?? brief.theme;
  const card = h('article', { class: `card${o.sample ? ' sample' : ''}`, 'data-brief-id': brief.id, 'aria-label': brief.title });
  if (o.sample) card.append(h('span', { class: 'sample-tag' }, 'Sample — press Generate for your own'));

  // Chips + name + note + palette + moment: the part you read first.
  const due = brief.art?.deadline ? `Due in ${brief.art.deadline === 'tomorrow' ? '1 day' : brief.art.deadline}` : null;
  card.append(
    h(
      'div',
      { class: 'chips-row' },
      brief.art?.purpose ? h('span', { class: 'job-chip' }, brief.art.purpose) : null,
      due ? h('span', { class: 'due-chip' }, icon('clock'), due) : null,
      brief.stat && o.showDnd ? h('span', { class: 'due-chip stat' }, icon('d20'), brief.stat) : null,
    ),
    h('h2', { class: 'title' }, brief.fields.name?.text ?? brief.title),
    h('p', { class: 'note' }, summaryNote(brief)),
    paletteDots(brief, hd),
  );
  if (o.board) card.append(o.board);
  if (brief.lore?.moment)
    card.append(h('div', { class: 'moment' }, h('span', { class: 'moment-label' }, 'Moment to paint'), h('p', {}, brief.lore.moment)));

  // Every detail: the full brief with lock / reroll on each line.
  const titleLocked = isLocked(brief, tpl.titleLock);
  const dl = h('dl', { class: 'lines' });
  for (const line of brief.lines) {
    const slots = line.slots ?? [line.slot];
    const locked = isLocked(brief, slots);
    const value = line.slot === 'palette' ? swatches(brief, hd) : document.createTextNode(line.text);
    dl.append(
      h(
        'div',
        { class: `row line${locked ? ' locked' : ''}`, 'data-slot': line.slot },
        h('dt', {}, line.label, o.showDnd ? rollChip(brief, line.slot, o) : null),
        h('dd', {}, h('span', { class: 'value' }, value), o.sample ? null : lineActions(brief, line.label, slots, slots, o, hd)),
      ),
    );
  }
  const details: (HTMLElement | null)[] = [
    h(
      'div',
      { class: `row title-row${titleLocked ? ' locked' : ''}` },
      h('p', { class: 'title-full' }, brief.title),
      o.sample ? null : lineActions(brief, 'Title', tpl.titleLock, tpl.titleReroll, o, hd),
    ),
    brief.art?.ask ? h('p', { class: 'ask-line' }, h('span', { class: 'ask-label' }, 'The ask'), `${brief.art.ask}.`) : null,
    dl,
  ];

  // Story: the lore (or a button to add one).
  const story: HTMLElement[] = [];
  if (brief.lore?.text) {
    story.push(
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
  } else {
    story.push(h('p', { class: 'empty-tab' }, 'No story on this card yet.'));
    if (!o.sample)
      story.push(
        h(
          'button',
          { class: 'btn', type: 'button', 'data-focus': `lore-add:${o.index}`, onclick: () => hd.addLore(o.index) },
          icon('book'),
          'Add lore',
        ),
      );
  }

  // Three collapsed rows for everything else.
  const open = new Set(o.open ?? []);
  const section = (id: CardSection, label: string, meta: string, body: HTMLElement[]) => {
    const d = h(
      'details',
      { class: 'acc', open: open.has(id), 'data-section': id },
      h('summary', { 'data-focus': `acc:${o.index}:${id}` }, h('b', {}, label), h('span', { class: 'acc-meta' }, meta)),
      h('div', { class: 'acc-body' }, ...body),
    );
    d.addEventListener('toggle', () => hd.setOpen(o.index, id, d.open));
    return d;
  };
  card.append(
    section(
      'details',
      'Every detail',
      `${brief.lines.length} lines · lock & reroll`,
      details.filter((x): x is HTMLElement => !!x),
    ),
    section('story', 'Story', brief.lore?.spine ?? (brief.lore ? 'lore' : 'not added yet'), story),
    section('direction', 'Direction', 'shape · focal · light · camera · deliverables', directionPanel(brief, o, hd)),
  );

  if (!o.sample) {
    card.append(
      h(
        'div',
        { class: 'card-foot' },
        h('span', { class: 'meta' }, `${themeName} · ${brief.weirdness} · ${brief.seed}`),
        h(
          'div',
          { class: 'foot-actions' },
          iconButton('Copy', 'copy', () => hd.copy(o.index), { 'data-focus': `copy:${o.index}` }),
          o.showChatGPT ? iconButton('Copy for ChatGPT', 'chat', () => hd.copyChat(o.index), { 'data-focus': `chat:${o.index}` }) : null,
          iconButton(
            o.saved ? 'Remove from saved' : 'Save',
            'star',
            () => hd.save(o.index),
            { 'aria-pressed': String(o.saved), 'data-focus': `save:${o.index}` },
            o.saved,
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
          iconButton('Link', 'link', () => hd.link(o.index), { 'data-focus': `link:${o.index}` }),
        ),
      ),
    );
  }
  return card;
}
