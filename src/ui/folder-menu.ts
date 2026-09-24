import type { Folder } from '../library';
import { h, icon } from './dom';

export interface FolderMenuOptions {
  folders: Folder[];
  /** Current folder id (undefined = Unsorted). */
  current: string | undefined;
  title?: string;
  onPick: (folderId: string | undefined) => void;
  /** Create a folder and return its id (or null if the name was empty). */
  onCreate: (name: string) => string | null;
}

let openMenu: { close: (refocus?: boolean) => void } | null = null;

export function closeFolderMenu() {
  openMenu?.close(false);
}

/** Small popover anchored to a button: pick a folder, or type a new one in place. Arrow keys, Enter, Esc. */
export function openFolderMenu(anchor: HTMLElement, o: FolderMenuOptions) {
  const wasOpenHere = openMenu && anchor.getAttribute('aria-expanded') === 'true';
  closeFolderMenu();
  if (wasOpenHere) return; // second click on the same button closes it

  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': o.title ?? 'Move to folder' });
  const item = (label: string, id: string | undefined) =>
    h(
      'button',
      {
        class: 'menu-item',
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(o.current === id),
        'data-folder': id ?? '',
        onclick: () => {
          close(true);
          if (o.current !== id) o.onPick(id);
        },
      },
      h('span', { class: 'menu-check', 'aria-hidden': 'true' }, o.current === id ? icon('check') : null),
      icon('folder'),
      h('span', { class: 'menu-label' }, label),
    );

  const newBtn = h(
    'button',
    { class: 'menu-item menu-new', type: 'button', role: 'menuitem', onclick: () => showForm() },
    h('span', { class: 'menu-check', 'aria-hidden': 'true' }),
    icon('folderPlus'),
    h('span', { class: 'menu-label' }, 'New folder…'),
  );

  menu.append(
    h('div', { class: 'menu-title' }, o.title ?? 'Move to folder'),
    item('Unsorted', undefined),
    ...o.folders.map((f) => item(f.name, f.id)),
    h('div', { class: 'menu-sep', role: 'separator' }),
    newBtn,
  );

  function showForm() {
    const input = h('input', {
      class: 'menu-input',
      type: 'text',
      maxlength: '40',
      placeholder: 'Folder name',
      'aria-label': 'New folder name',
    });
    const create = () => {
      const id = o.onCreate(input.value);
      if (id === null) return input.focus();
      close(true);
      o.onPick(id);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        create();
      }
    });
    const form = h(
      'div',
      { class: 'menu-form' },
      input,
      h('button', { class: 'mini', type: 'button', 'aria-label': 'Create folder', title: 'Create folder', onclick: create }, icon('check')),
    );
    newBtn.replaceWith(form);
    input.focus();
    position();
  }

  const items = () => [...menu.querySelectorAll<HTMLElement>('.menu-item, .menu-input')];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    }
    if (e.key === 'Tab') return close(false);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (document.activeElement instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close(false);
  };

  function position() {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    const below = r.bottom + 6;
    const top = below + mh > window.innerHeight - 8 && r.top - mh - 6 > 8 ? r.top - mh - 6 : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  function close(refocus = false) {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', position, true);
    anchor.setAttribute('aria-expanded', 'false');
    openMenu = null;
    if (refocus && anchor.isConnected) anchor.focus();
  }
  const onResize = () => close(false);

  document.body.append(menu);
  position();
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', position, true);
  openMenu = { close };
  (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? items()[0])?.focus();
}
