import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { chatText, storyText } from './chat';
import { copyText } from './clipboard';
import { loadData } from './data';
import { countCombinations, formatCount } from './engine/count';
import { generateBatch, generateVariation, lockedMap, rerollArt, rerollSlots, rollTheme, setLocked, type Pin } from './engine/generate';
import { fullText, withLore, withoutLore } from './engine/lore';
import { chooseFreshBatch, pushRecent } from './engine/recent';
import { CATEGORY_IDS, WEIRDNESS, type Brief, type CategoryId, type SlotId, type ThemeId, type Weirdness } from './engine/types';
import { decodeShare, encodeShare, type ShareState } from './share';
import {
  addToHistory,
  clearKey,
  exportFileName,
  exportSaved,
  loadFolders,
  saveFolders,
  importSaved,
  loadHistory,
  loadRecent,
  loadSaved,
  loadSettings,
  saveHistory,
  saveRecent,
  saveSaved,
  saveSettings,
  storageAvailable,
  type Settings,
} from './storage';
import { renderCard, type CardHandlers } from './ui/card';
import { h, icon } from './ui/dom';
import { renderHistory, renderSaved, type ListsHandlers } from './ui/history';
import { openFolderMenu } from './ui/folder-menu';
import {
  createFolder,
  deleteFolder,
  folderName,
  folderOf,
  moveBrief,
  removeBrief,
  renameFolder,
  saveBrief,
  validFilter,
  type Folder,
  type LibraryFilter,
} from './library';
import { openSettings } from './ui/settings';
import { toast } from './ui/toast';

declare const __APP_VERSION__: string;

const data = loadData();
const storageOk = storageAvailable();
let settings: Settings = loadSettings();
let historyList: Brief[] = loadHistory();
let saved: Record<string, Brief> = loadSaved();
let folders: Folder[] = loadFolders();
let recent: Record<string, string[]> = loadRecent();

const WEIRD_LABEL: Record<Weirdness, string> = { grounded: 'Grounded', mixed: 'Mixed', wild: 'Wild' };
const SAMPLE_BASE = 'K7Q2PX';

const state = {
  category: (CATEGORY_IDS.includes(settings.last.category) ? settings.last.category : 'character') as CategoryId,
  themeChoice: (settings.last.themeChoice === 'any' || data.themeById[settings.last.themeChoice] ? settings.last.themeChoice : 'any') as
    ThemeId | 'any',
  count: Math.min(4, Math.max(1, settings.last.count || 2)),
  weirdness: (WEIRDNESS.includes(settings.last.weirdness) ? settings.last.weirdness : 'mixed') as Weirdness,
  lore: !!settings.last.lore,
  results: [] as Brief[],
  sample: null as Brief | null,
  notice: null as string | null,
  listsOpen: { history: false, saved: false },
  libraryFilter: validFilter(settings.libraryFilter ?? 'all', folders) as LibraryFilter,
  editing: null as string | null,
  savedOpen: false,
};

// ---------- helpers ----------

function entropy(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function persistLast() {
  settings = {
    ...settings,
    last: { category: state.category, themeChoice: state.themeChoice, count: state.count, weirdness: state.weirdness, lore: state.lore },
  };
  saveSettings(settings);
}

function applyColorScheme() {
  const root = document.documentElement;
  if (settings.colorScheme === 'system') delete root.dataset.theme;
  else root.dataset.theme = settings.colorScheme;
}

async function doCopy(text: string, okMsg = 'Copied') {
  const ok = await copyText(text);
  toast(ok ? okMsg : 'Copy failed — select the text and copy manually');
  return ok;
}

function shareUrl(s: ShareState): string {
  return `${location.origin}${location.pathname}${encodeShare(s)}`;
}

function replaceInHistory(oldId: string, next: Brief) {
  historyList = historyList.some((b) => b.id === oldId)
    ? historyList.map((b) => (b.id === oldId ? next : b))
    : addToHistory(historyList, [next]);
  historyList = historyList.filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i);
  saveHistory(historyList);
}

// ---------- skeleton ----------

const app = document.getElementById('app')!;
const settingsBtn = h(
  'button',
  { class: 'icon-btn', type: 'button', 'aria-label': 'Settings', onclick: () => showSettings() },
  icon('gear'),
);
const savedCount = h('span', { class: 'badge', 'aria-hidden': 'true' }, '0');
const savedBtn = h(
  'button',
  {
    class: 'saved-toggle',
    type: 'button',
    id: 'saved-toggle',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    'aria-controls': 'saved-panel',
    onclick: () => toggleSavedPanel(),
  },
  icon('star'),
  h('span', { class: 'saved-toggle-label' }, 'Saved'),
  savedCount,
);
const savedPanel = h('div', { class: 'saved-pop', id: 'saved-panel', role: 'dialog', 'aria-label': 'Saved briefs', hidden: true });
const pillsEl = h('div', { class: 'pills', role: 'group', 'aria-label': 'Category' });
const themeSelect = h('select', { class: 'theme', id: 'theme', 'aria-label': 'Theme' });
const countSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Variations' });
const weirdSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Weirdness' });
const loreBox = h('input', { type: 'checkbox', id: 'lore-toggle' });
loreBox.checked = state.lore;
loreBox.addEventListener('change', () => {
  state.lore = loreBox.checked;
  persistLast();
});
const generateBtn = h(
  'button',
  { class: 'generate', type: 'button', id: 'generate', onclick: () => generate() },
  h('span', { class: 'die', 'aria-hidden': 'true' }, icon('d20')),
  'Generate',
);
const noticesEl = h('div', { 'aria-live': 'polite' });
const resultsEl = h('section', { class: 'results', 'aria-label': 'Results', id: 'results' });
const listsEl = h('div');
const footEl = h('footer', { class: 'foot' });

app.append(
  h(
    'div',
    { class: 'wrap' },
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Art Brief'),
      h('div', { class: 'top-actions' }, savedBtn, settingsBtn),
      savedPanel,
    ),
    h(
      'main',
      {},
      h('h1', { class: 'ask' }, 'What do you want to create?'),
      pillsEl,
      h('div', { class: 'field-row' }, h('label', { class: 'label', for: 'theme' }, 'Theme'), themeSelect),
      h('div', { class: 'field-row' }, h('span', { class: 'label' }, 'Variations'), countSeg),
      h('div', { class: 'field-row' }, h('span', { class: 'label' }, 'Weirdness'), weirdSeg),
      h(
        'div',
        { class: 'field-row' },
        h('span', { class: 'label' }, 'Lore'),
        h('label', { class: 'check lore-check', for: 'lore-toggle' }, loreBox, 'Add a short story to each card'),
      ),
      generateBtn,
      h('p', { class: 'hint' }, 'Enter or Space to generate · lock a line to keep it'),
      noticesEl,
      resultsEl,
      listsEl,
    ),
    footEl,
  ),
);

themeSelect.append(h('option', { value: 'any' }, 'Any (surprise me)'), ...data.themes.map((t) => h('option', { value: t.id }, t.name)));
themeSelect.addEventListener('change', () => {
  state.themeChoice = themeSelect.value as ThemeId | 'any';
  persistLast();
});

function renderControls() {
  pillsEl.replaceChildren(
    ...CATEGORY_IDS.map((c) =>
      h(
        'button',
        {
          class: 'pill',
          type: 'button',
          'aria-pressed': String(state.category === c),
          'data-category': c,
          onclick: () => {
            state.category = c;
            persistLast();
            renderControls();
            renderFooter();
            (pillsEl.querySelector(`[data-category="${c}"]`) as HTMLElement | null)?.focus();
          },
        },
        data.categories[c].name,
      ),
    ),
  );
  themeSelect.value = state.themeChoice;
  const seg = (el: HTMLElement, items: { v: string; label: string; aria: string }[], current: string, set: (v: string) => void) => {
    el.replaceChildren(
      ...items.map((it) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(it.v === current),
            'aria-label': it.aria,
            'data-value': it.v,
            onclick: () => {
              set(it.v);
              persistLast();
              renderControls();
              (el.querySelector(`[data-value="${it.v}"]`) as HTMLElement | null)?.focus();
            },
          },
          it.label,
        ),
      ),
    );
  };
  seg(
    countSeg,
    [1, 2, 3, 4].map((n) => ({ v: String(n), label: String(n), aria: `${n} variation${n > 1 ? 's' : ''}` })),
    String(state.count),
    (v) => (state.count = Number(v)),
  );
  seg(
    weirdSeg,
    WEIRDNESS.map((w) => ({ v: w, label: WEIRD_LABEL[w], aria: `Weirdness ${WEIRD_LABEL[w]}` })),
    state.weirdness,
    (v) => (state.weirdness = v as Weirdness),
  );
}

function renderNotices() {
  const items: HTMLElement[] = [];
  if (!storageOk)
    items.push(
      h(
        'p',
        { class: 'notice', id: 'storage-notice' },
        'Saving is off in this browser mode — briefs will not be kept after you close the page.',
      ),
    );
  if (state.notice) items.push(h('p', { class: 'notice', id: 'data-notice' }, state.notice));
  noticesEl.replaceChildren(...items);
}

function renderFooter() {
  const n = countCombinations(data, state.category);
  footEl.replaceChildren(
    h('p', { id: 'combo-count' }, `${formatCount(n)} ${data.categories[state.category].name} briefs possible`),
    h('p', {}, `app ${__APP_VERSION__} · data ${data.version}`),
  );
}

const cardHandlers: CardHandlers = {
  toggleLock(i, slots) {
    const b = state.results[i];
    if (!b) return;
    const locked = slots.every((s) => b.fields[s]?.locked);
    state.results[i] = setLocked(b, slots, !locked);
    replaceInHistory(b.id, state.results[i]);
    rerenderCard(i);
  },
  reroll(i, slots) {
    const b = state.results[i];
    if (!b) return;
    const next = rerollSlots(data, b, slots, settings.uniqueFrequency);
    next.createdAt = Date.now();
    state.results[i] = next;
    replaceInHistory(b.id, next);
    rerenderCard(i);
    renderLists();
  },
  copy(i) {
    const b = state.results[i];
    if (b) void doCopy(fullText(b, settings.showDnd));
  },
  copyChat(i) {
    const b = state.results[i];
    if (!b) return;
    void doCopy(chatText([b], settings.instruction, settings.showDnd), 'Copied for ChatGPT');
    if (settings.openChatGPT) window.open('https://chatgpt.com/', '_blank', 'noopener');
  },
  save(i) {
    const b = state.results[i];
    if (b) toggleSave(b);
  },
  moveFolder(i, anchor) {
    const b = state.results[i];
    if (b && saved[b.id]) moveMenu(saved[b.id], anchor);
  },
  link(i) {
    const b = state.results[i];
    if (!b) return;
    const fields: Record<SlotId, string> = {};
    for (const [s, f] of Object.entries(b.fields)) fields[s] = f.entryId;
    const url = shareUrl({
      category: b.category,
      themeChoice: b.theme,
      weirdness: b.weirdness,
      count: 1,
      base: b.base,
      version: b.dataVersion,
      uniqueFrequency: settings.uniqueFrequency,
      index: b.index,
      seed: b.seed,
      fields,
      locked: lockedMap(b),
      lore: b.lore?.roll,
      art: b.rerolls.art,
    });
    void doCopy(url, 'Link copied');
  },
  swatch(hex) {
    void doCopy(hex, `Copied ${hex}`);
  },
  addLore(i) {
    updateCard(i, (b) => withLore(data, b, 0), 'lore-reroll');
  },
  rerollLore(i) {
    updateCard(i, (b) => withLore(data, b, (b.lore?.roll ?? 0) + 1), 'lore-reroll');
  },
  hideLore(i) {
    updateCard(i, (b) => withoutLore(b), 'lore-add');
  },
  rerollArt(i) {
    updateCard(i, (b) => rerollArt(data, b, settings.uniqueFrequency), 'art-reroll');
  },
  refineLore(i) {
    const b = state.results[i];
    if (!b?.lore) return;
    void doCopy(storyText(b, settings.storyInstruction, settings.showDnd), 'Story copied for ChatGPT');
    if (settings.openChatGPT) window.open('https://chatgpt.com/', '_blank', 'noopener');
  },
};

/** Replace one card's brief (keeping history and saved in step) and move focus to a control on the new card. */
function updateCard(i: number, fn: (b: Brief) => Brief, focusPrefix?: string) {
  const b = state.results[i];
  if (!b) return;
  const next = fn(b);
  state.results[i] = next;
  replaceInHistory(b.id, next);
  if (saved[b.id]) {
    saved = { ...saved, [b.id]: next };
    saveSaved(saved);
  }
  rerenderCard(i);
  if (focusPrefix)
    (resultsEl.querySelectorAll('.card')[i]?.querySelector(`[data-focus="${focusPrefix}:${i}"]`) as HTMLElement | null)?.focus();
}

function cardFor(b: Brief, i: number): HTMLElement {
  const s = saved[b.id];
  return renderCard(
    b,
    {
      index: i,
      saved: !!s,
      folderName: s ? folderName(folderOf(s, folders), folders) : undefined,
      showChatGPT: settings.showChatGPT,
      showDnd: settings.showDnd,
      data,
    },
    cardHandlers,
  );
}

function rerenderCard(i: number) {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  const old = resultsEl.querySelectorAll('.card')[i];
  const b = state.results[i];
  if (!old || !b) return renderResults();
  const next = cardFor(b, i);
  next.style.animation = 'none';
  old.replaceWith(next);
  if (focusKey) (next.querySelector(`[data-focus="${focusKey}"]`) as HTMLElement | null)?.focus();
}

function renderResults() {
  const kids: HTMLElement[] = [];
  if (state.results.length >= 2) {
    kids.push(
      h(
        'div',
        { class: 'results-bar' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            id: 'copy-all',
            onclick: () => void doCopy(state.results.map((b) => fullText(b, settings.showDnd)).join('\n\n---\n\n'), 'Copied all'),
          },
          icon('copy'),
          'Copy all',
        ),
        settings.showChatGPT
          ? h(
              'button',
              {
                class: 'btn',
                type: 'button',
                id: 'copy-all-chat',
                onclick: () => {
                  void doCopy(chatText(state.results, settings.instruction, settings.showDnd), 'Copied all for ChatGPT');
                  if (settings.openChatGPT) window.open('https://chatgpt.com/', '_blank', 'noopener');
                },
              },
              icon('chat'),
              'Copy all for ChatGPT',
            )
          : null,
      ),
    );
  }
  const cards = h('div', { class: 'cards' });
  if (state.sample && !state.results.length) {
    cards.append(renderCard(state.sample, { index: -1, saved: false, showChatGPT: false, sample: true, data }, cardHandlers));
  }
  state.results.forEach((b, i) => cards.append(cardFor(b, i)));
  kids.push(cards);
  resultsEl.replaceChildren(...kids);
  resultsEl.hidden = !state.results.length && !state.sample;
}

function renderLists() {
  state.libraryFilter = validFilter(state.libraryFilter, folders);
  const st = { history: historyList, saved, folders, filter: state.libraryFilter, open: state.listsOpen, editing: state.editing };
  const handlers: ListsHandlers = {
    restore(b) {
      toggleSavedPanel(false);
      state.results = [b];
      state.sample = null;
      state.category = b.category;
      persistLast();
      renderControls();
      renderFooter();
      renderResults();
      resultsEl.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    },
    toggle(which, open) {
      state.listsOpen[which] = open;
    },
    toggleSave,
    removeHistory(b) {
      const before = historyList;
      historyList = historyList.filter((x) => x.id !== b.id);
      saveHistory(historyList);
      refresh();
      toast('Removed from history', { action: { label: 'Undo', run: () => ((historyList = before), saveHistory(before), refresh()) } });
    },
    clearHistory() {
      const before = historyList;
      historyList = [];
      clearKey('history');
      refresh('chip:all');
      toast('History cleared — saved briefs kept', {
        action: { label: 'Undo', run: () => ((historyList = before), saveHistory(before), refresh()) },
      });
    },
    setFilter(filter) {
      state.libraryFilter = filter;
      settings = { ...settings, libraryFilter: filter };
      saveSettings(settings);
      refresh();
    },
    moveMenu,
    removeSaved(b) {
      const snapshot = saved[b.id];
      setSaved(removeBrief(saved, b.id));
      toast('Removed from saved', { action: { label: 'Undo', run: () => setSaved({ ...saved, [b.id]: snapshot }) } });
    },
    moveTo(briefId, folderId) {
      if (!saved[briefId] || folderOf(saved[briefId], folders) === folderId) return;
      setSaved(moveBrief(saved, briefId, folderId));
      toast(`Moved to ${folderName(folderId, folders)}`);
    },
    createFolder: addFolder,
    renameFolder(id, name) {
      const next = renameFolder(folders, id, name);
      if (next === folders && name.trim() && folders.find((f) => f.id === id)?.name !== name.trim())
        toast('A folder with that name already exists');
      setFolders(next);
      refresh(`chip:${id}`);
    },
    deleteFolder(id) {
      const f = folders.find((x) => x.id === id);
      if (!f) return;
      const before = { folders, saved, filter: state.libraryFilter };
      const moved = Object.values(saved).filter((b) => b.folder === id).length;
      const r = deleteFolder(folders, saved, id);
      state.libraryFilter = 'unsorted';
      setFolders(r.folders);
      setSaved(r.saved, 'chip:unsorted');
      toast(`Deleted “${f.name}”${moved ? ` — ${moved} moved to Unsorted` : ''}`, {
        action: {
          label: 'Undo',
          run: () => {
            state.libraryFilter = before.filter;
            setFolders(before.folders);
            setSaved(before.saved, `chip:${id}`);
          },
        },
      });
    },
  };
  const setEditing = (v: string | null) => {
    state.editing = v;
    refresh(v === 'new' ? undefined : v ? undefined : 'chip:new');
  };
  listsEl.replaceChildren(renderHistory(st, data, handlers));
  savedCount.textContent = String(Object.keys(saved).length);
  savedBtn.setAttribute('aria-label', `Saved briefs (${Object.keys(saved).length})`);
  if (state.savedOpen) savedPanel.replaceChildren(savedHead(), renderSaved(st, data, handlers, setEditing));
}

function savedHead() {
  return h(
    'div',
    { class: 'saved-pop-head' },
    h('h2', {}, 'Saved'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close saved', onclick: () => toggleSavedPanel(false) }, icon('close')),
  );
}

let savedOutside: ((e: PointerEvent) => void) | null = null;

/** The Saved library opens as a dropdown under the header button. */
function toggleSavedPanel(open = !state.savedOpen) {
  state.savedOpen = open;
  savedPanel.hidden = !open;
  savedBtn.setAttribute('aria-expanded', String(open));
  if (savedOutside) document.removeEventListener('pointerdown', savedOutside, true);
  savedOutside = null;
  if (!open) {
    savedPanel.replaceChildren();
    return;
  }
  renderLists();
  savedOutside = (e: PointerEvent) => {
    const t = e.target as Element;
    if (savedPanel.contains(t) || savedBtn.contains(t) || t.closest('.menu, .toast')) return;
    toggleSavedPanel(false);
  };
  document.addEventListener('pointerdown', savedOutside, true);
  savedPanel.querySelector<HTMLElement>('.chip[aria-pressed="true"]')?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.savedOpen && !document.querySelector('.menu')) {
    toggleSavedPanel(false);
    savedBtn.focus();
  }
});

// ---------- saved library ----------

/** Re-render cards and lists, keeping keyboard focus on the same control (or on `fallback`). */
function refresh(fallback?: string) {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  renderResults();
  renderLists();
  const find = (k?: string) => (k ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(k)}"]`) : null);
  (find(key) ?? find(fallback))?.focus();
}

function setSaved(next: Record<string, Brief>, focusFallback?: string) {
  saved = next;
  saveSaved(saved);
  refresh(focusFallback);
}

function setFolders(next: Folder[]) {
  folders = next;
  saveFolders(folders);
}

function newFolderId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `f-${Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('')}`;
}

function addFolder(name: string): string | null {
  const r = createFolder(folders, name, newFolderId(), Date.now());
  if (!r.folder) {
    toast('Give the folder a name');
    return null;
  }
  if (r.folders !== folders) {
    setFolders(r.folders);
    toast(`Folder “${r.folder.name}” created`);
  }
  return r.folder.id;
}

/** New saves go into the folder you're looking at (Unsorted when viewing All or Unsorted). */
function currentSaveFolder(): string | undefined {
  return state.libraryFilter !== 'all' && state.libraryFilter !== 'unsorted' ? state.libraryFilter : undefined;
}

function toggleSave(b: Brief) {
  if (saved[b.id]) {
    const snapshot = saved[b.id];
    setSaved(removeBrief(saved, b.id));
    toast('Removed from saved', { action: { label: 'Undo', run: () => setSaved({ ...saved, [b.id]: snapshot }) } });
    return;
  }
  const folder = currentSaveFolder();
  setSaved(saveBrief(saved, b, folder, Date.now()));
  toast(`Saved to ${folderName(folder, folders)}`);
  savedBtn.classList.remove('pulse');
  void savedBtn.offsetWidth; // restart the animation
  savedBtn.classList.add('pulse');
}

function moveMenu(b: Brief, anchor: HTMLElement) {
  openFolderMenu(anchor, {
    folders,
    current: folderOf(b, folders),
    onPick: (folderId) => {
      setSaved(moveBrief(saved, b.id, folderId));
      toast(`Moved to ${folderName(folderId, folders)}`);
    },
    onCreate: addFolder,
  });
}

// ---------- actions ----------

let busy = false;

function generate() {
  if (busy) return;
  busy = true;
  generateBtn.setAttribute('aria-disabled', 'true');
  generateBtn.classList.remove('rolling');
  void generateBtn.offsetWidth; // restart the roll animation
  generateBtn.classList.add('rolling');
  window.setTimeout(() => {
    busy = false;
    generateBtn.removeAttribute('aria-disabled');
  }, 150);

  const cat = data.categories[state.category];
  const locks = state.results.map((b) => (b.category === state.category ? lockedMap(b) : undefined));
  const { briefs } = chooseFreshBatch(
    data,
    {
      category: state.category,
      themeChoice: state.themeChoice,
      weirdness: state.weirdness,
      count: state.count,
      uniqueFrequency: settings.uniqueFrequency,
      locks,
      lore: state.lore,
      createdAt: Date.now(),
    },
    entropy(),
    recent[state.category] ?? [],
  );
  state.results = briefs;
  state.sample = null;
  state.notice = null;
  historyList = addToHistory(historyList, briefs);
  saveHistory(historyList);
  recent = {
    ...recent,
    [state.category]: pushRecent(
      recent[state.category] ?? [],
      briefs.map((b) => b.fields[cat.primarySlot].entryId),
    ),
  };
  saveRecent(recent);
  renderNotices();
  renderResults();
  renderLists();
}

function applyShare(s: ShareState) {
  state.category = s.category;
  state.themeChoice = s.themeChoice;
  state.weirdness = s.weirdness;
  state.count = s.count;
  let briefs: Brief[];
  if (s.index !== undefined && s.fields) {
    const pins: Record<SlotId, Pin> = {};
    for (const [slot, entryId] of Object.entries(s.fields)) pins[slot] = { entryId, locked: s.locked?.[slot] === entryId };
    for (const [slot, entryId] of Object.entries(s.locked ?? {})) if (!pins[slot]) pins[slot] = { entryId, locked: true };
    const theme = s.themeChoice === 'any' ? rollTheme(data, s.base, s.index) : s.themeChoice;
    briefs = [
      generateVariation(data, {
        category: s.category,
        theme,
        themeChoice: s.themeChoice,
        weirdness: s.weirdness,
        base: s.base,
        index: s.index,
        seed: s.seed ?? `${s.base}-${s.index}`,
        uniqueFrequency: s.uniqueFrequency,
        pins,
        rerolls: s.art ? { art: s.art } : undefined,
        createdAt: Date.now(),
      }),
    ];
  } else {
    briefs = generateBatch(data, {
      category: s.category,
      themeChoice: s.themeChoice,
      weirdness: s.weirdness,
      count: s.count,
      base: s.base,
      uniqueFrequency: s.uniqueFrequency,
      locks: s.locked ? Array.from({ length: s.count }, () => s.locked) : undefined,
      createdAt: Date.now(),
    });
  }
  if (s.lore !== undefined) briefs = briefs.map((b) => withLore(data, b, s.lore));
  state.results = briefs;
  state.sample = null;
  state.notice = s.version && s.version !== data.version ? 'Made with older data; some lines may differ.' : null;
  historyList = addToHistory(historyList, briefs);
  saveHistory(historyList);
  persistLast();
}

function showSettings() {
  openSettings(
    settings,
    {
      appVersion: __APP_VERSION__,
      dataVersion: data.version,
      savedCount: Object.keys(saved).length,
      historyCount: historyList.length,
      storageOk,
    },
    {
      change(patch) {
        const chatChanged =
          (patch.showChatGPT !== undefined && patch.showChatGPT !== settings.showChatGPT) ||
          (patch.showDnd !== undefined && patch.showDnd !== settings.showDnd);
        settings = { ...settings, ...patch };
        saveSettings(settings);
        applyColorScheme();
        if (chatChanged) renderResults();
      },
      exportSaved() {
        const blob = new Blob([exportSaved(saved, folders)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: exportFileName() });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast(`Exported ${Object.keys(saved).length} saved`);
      },
      async importSaved(file) {
        try {
          const r = importSaved(saved, await file.text(), folders);
          saved = r.saved;
          saveSaved(saved);
          setFolders(r.folders);
          toast(`Imported ${r.added} new`);
          renderResults();
          renderLists();
        } catch {
          toast('That file is not an Art Brief export');
        }
      },
      clearHistory() {
        historyList = [];
        clearKey('history');
        renderLists();
        toast('History cleared');
      },
      clearSaved() {
        saved = {};
        clearKey('saved');
        renderResults();
        renderLists();
        toast('Saved cleared');
      },
    },
    settingsBtn,
  );
}

// Enter / Space generate unless focus is in something that handles those keys itself.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement | null;
  if (t && t.closest('input, textarea, select, button, a, summary, [contenteditable], [role="dialog"]')) return;
  e.preventDefault();
  generate();
});

// ---------- boot ----------

applyColorScheme();
const shared = decodeShare(location.hash, data);
if (shared) {
  applyShare(shared);
  history.replaceState(null, '', location.pathname + location.search);
} else if (!historyList.length) {
  state.sample = generateBatch(data, {
    category: 'character',
    themeChoice: 'fey',
    weirdness: 'mixed',
    count: 1,
    base: SAMPLE_BASE,
    uniqueFrequency: 'sometimes',
    lore: true,
  })[0];
}
renderControls();
renderNotices();
renderResults();
renderLists();
renderFooter();

// A share link opened while the app is already showing in this tab only changes the hash.
window.addEventListener('hashchange', () => {
  const s = decodeShare(location.hash, data);
  if (!s) return;
  applyShare(s);
  history.replaceState(null, '', location.pathname + location.search);
  renderControls();
  renderNotices();
  renderResults();
  renderLists();
  renderFooter();
});

// ---------- service worker / update pill ----------

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const updateSW = registerSW({
    onNeedRefresh() {
      if (document.getElementById('update-pill')) return;
      const pill = h(
        'button',
        { class: 'update-pill', id: 'update-pill', type: 'button', onclick: () => void updateSW(true) },
        'New version — Refresh',
      );
      document.body.append(pill);
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      setInterval(() => void reg.update(), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update();
      });
    },
  });
}
