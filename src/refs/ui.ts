/** Reference finder page (Option 2 · Feed). Built with DOM calls only; text goes through textContent. */
import './refs.css';
import { Search, type Hit } from './engine';
import { SOURCES, SOURCE_BY_ID } from './sources';
import { loadPrefs, loadRefs, refFrom, savePrefs, saveRefs, type SavedRef } from './store';
import type { Cand, Mode } from './types';
import { embedBitmap, onVisionState, visionState, warmVision } from './vision';
import { describePose, fromMoveNet, inkBox, looksLikeSketch, readSketch, templatePose, type Pt, type Skeleton } from './pose';
import { completions, corrected, display, loadVocab, normWords, resolveQuery, V, words, type Vocab } from './vocab';
import { hideToast, toast, toastHost } from '../ui/toast';
import { rngFrom, seedFromBytes } from '../engine/rng';
import { showUrl } from './net';
import { openFolderMenu } from '../ui/folder-menu';
import type { Folder } from '../library';

export interface RefsHost {
  folders(): Folder[];
  addFolder(name: string): string | null;
  onSavedChange(count: number): void;
  /** The Saved view opened or closed (the header's Saved button reflects it). */
  onSavedView(open: boolean): void;
}
export interface RefsPage {
  show(): void;
  hide(): void;
  toggleSaved(): void;
  savedCount(): number;
}

// ---------------------------------------------------------------- tiny DOM helpers
type Kids = Array<Node | string | null | undefined | false>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined | null> = {},
  ...kids: Kids
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const SVG = 'http://www.w3.org/2000/svg';
const PATHS: Record<string, string[]> = {
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-3.5-3.5'],
  image: [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M9 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  ],
  sliders: ['M20 7h-9', 'M14 17H4', 'M17 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M7 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  mirror: ['M12 3v18', 'M8 7 3 12l5 5V7z', 'm16 7 5 5-5 5V7z'],
  flip: [
    'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3',
    'M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3',
    'M12 20v2',
    'M12 14v2',
    'M12 8v2',
    'M12 2v2',
  ],
  whole: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  auto: ['M12 3l1.8 4.9L19 10l-5.2 2.1L12 17l-1.8-4.9L5 10l5.2-2.1z', 'M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z'],
  pose: ['M12 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M5 9l7 2 7-2', 'M12 11v4', 'M9 21l3-6 3 6'],
  concept: ['M9 18h6', 'M10 22h4', 'M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z'],
  place: ['m3 20 6-11 4 6 3-4 5 9z', 'M17 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
  prop: ['M14.5 17.5 3 6V3h3l11.5 11.5', 'M13 19l6-6', 'M16 16l4 4', 'M19 21l2-2'],
  creature: [
    'M11 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'M18 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'M4 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    'M8 14a4 4 0 0 1 8 0v2.5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z',
  ],
  up: [
    'M7 10v11',
    'M15 5.9 14 10h5.8a2 2 0 0 1 2 2.6l-2.4 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z',
  ],
  down: [
    'M17 14V3',
    'M9 18.1 10 14H4.2a2 2 0 0 1-2-2.6l2.4-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9z',
  ],
  star: ['m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1z'],
  ext: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  chev: ['m6 9 6 6 6-6'],
  left: ['m15 18-6-6 6-6'],
  right: ['m9 18 6-6-6-6'],
  layers: ['m12 2 10 5-10 5L2 7z', 'm2 17 10 5 10-5', 'M2 12l10 5 10-5'],
  check: ['M20 6 9 17l-5-5'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
};
function ic(name: string, cls = ''): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', `r-i ${cls}`.trim());
  for (const d of PATHS[name] ?? []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

// ---------------------------------------------------------------- constants
const MODES: Array<{ id: Mode; label: string; d: string }> = [
  { id: 'auto', label: 'Auto', d: 'Picks the best fit from your words' },
  { id: 'pose', label: 'Pose', d: 'Figures, gestures, action' },
  { id: 'concept', label: 'Concept', d: 'Mood, light, style, ideas' },
  { id: 'place', label: 'Place', d: 'Environments and buildings' },
  { id: 'prop', label: 'Prop', d: 'Weapons, armor, objects' },
  { id: 'creature', label: 'Creature', d: 'Animals and monsters' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.id, m.label])) as Record<Mode, string>;
const NARROW: Record<string, string[]> = {
  pose: ['two-handed', 'mid-swing', 'from below', 'back view', 'cape flowing', 'at night'],
  concept: ['backlit', 'moody', 'painterly', 'high contrast', 'cold palette'],
  place: ['at dusk', 'in fog', 'interior', 'aerial view', 'ruined'],
  prop: ['ornate', 'worn', 'close-up', 'on display', 'engraved'],
  creature: ['in flight', 'roaring', 'side view', 'close-up', 'in water'],
};
const JOINTS = ['head', 'neck', 'hip', 'elbowA', 'wristA', 'elbowB', 'wristB', 'kneeA', 'ankleA', 'kneeB', 'ankleB'] as const;
const JOINT_LABEL: Record<(typeof JOINTS)[number], string> = { head: 'Head', neck: 'Neck', hip: 'Hips', elbowA: 'Elbow', wristA: 'Hand', elbowB: 'Other elbow', wristB: 'Other hand', kneeA: 'Knee', ankleA: 'Foot', kneeB: 'Other knee', ankleB: 'Other foot' };
const BONES: Array<[(typeof JOINTS)[number], (typeof JOINTS)[number]]> = [['head', 'neck'], ['neck', 'hip'], ['neck', 'elbowA'], ['elbowA', 'wristA'], ['neck', 'elbowB'], ['elbowB', 'wristB'], ['hip', 'kneeA'], ['kneeA', 'ankleA'], ['hip', 'kneeB'], ['kneeB', 'ankleB']];
const IDEAS: Array<[string, string]> = [
  ['Sword fighters', 'pose'],
  ['Dragons', 'dragon'],
  ['Castles & ruins', 'castle'],
  ['Champion art', 'champion'],
];
/** The start screen's idea tiles (public/refs/ideas.json, from scripts/refs/build-ideas.mjs): a different
 *  8, each with a different picture, every time the page is opened. The four built-in tiles stand in
 *  when the list can't load. */
type Idea = { label: string; q: string; imgs: string[] };
type Tile = { idea: Idea; img: string };
let ideaPool: Promise<Idea[]> | null = null;
function loadIdeas(): Promise<Idea[]> {
  const fallback = (): Idea[] => IDEAS.map(([label, img]) => ({ label, q: label.replace('&', 'and'), imgs: [`${BASE}refs/tiles/${img}.jpg`] }));
  ideaPool ??= fetch(`${BASE}refs/ideas.json${V}`)
    .then((r) => (r.ok ? (r.json() as Promise<Idea[]>) : Promise.reject(new Error(String(r.status)))))
    .then((x) => (x.length >= 4 ? x : fallback()))
    .catch(() => {
      ideaPool = null; // try again next visit
      return fallback();
    });
  return ideaPool;
}
const LAST_IDEAS = 'ab:refs-ideas';
function pickTiles(pool: Idea[], n = 8): Tile[] {
  let last: string[] = [];
  try {
    last = JSON.parse(localStorage.getItem(LAST_IDEAS) ?? '[]') as string[];
  } catch {
    /* storage blocked: any 8 will do */
  }
  const rnd = rngFrom(seedFromBytes(crypto.getRandomValues(new Uint8Array(6)))); // a new draw every visit
  const shuffle = <T,>(a: T[]) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  // ideas not shown last time first, so consecutive visits don't repeat
  const picked = [...shuffle(pool.filter((x) => !last.includes(x.label))), ...shuffle(pool.filter((x) => last.includes(x.label)))].slice(0, n);
  try {
    localStorage.setItem(LAST_IDEAS, JSON.stringify(picked.map((x) => x.label)));
  } catch {
    /* not remembered: fine */
  }
  return picked.map((idea) => ({ idea, img: idea.imgs[Math.floor(rnd() * idea.imgs.length)] }));
}
const TONES = ['#2d2a33', '#4a3b2e', '#39424e', '#5b4636', '#2f3b35', '#4b3a4f', '#6b5a44', '#384a5c'];
const COARSE = matchMedia('(pointer: coarse)').matches;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const BASE = import.meta.env.BASE_URL;

type Crop = { x: number; y: number; w: number; h: number };
interface Snap {
  q: string;
  ran: string;
  bmp: ImageBitmap | null;
  imgUrl: string | null;
  like: Like | null;
  crop: Crop;
  mode: Mode;
  narrow: string[];
  sketch: Skeleton | null;
  photoPose: Skeleton | null;
  sketchEdited: boolean;
  unread: boolean;
}
interface Like {
  title: string;
  key: string;
  vec: Float32Array;
  url: string;
  seed: Hit[];
  down: Float32Array[]; // 👎 from the search it came from: not wanted here either
}

// ---------------------------------------------------------------- page
export function mountRefs(root: HTMLElement, host: RefsHost): RefsPage {
  const prefs = loadPrefs();
  const saved: Record<string, SavedRef> = loadRefs();
  let vocab: Vocab | null = null;
  void loadVocab()
    .then((v) => {
      vocab = v;
      refreshSug();
    })
    .catch(() => undefined);

  const S = {
    mode: 'auto' as Mode,
    tiles: null as Tile[] | null, // this visit's idea tiles
    visits: 0,
    feed: null as Search | null, // the start screen's feed of new work: kept while you search, so Back returns to it
    feedCells: [] as Hit[],
    q: '',
    ran: '',
    fix: null as { from: string; to: string } | null,
    bmp: null as ImageBitmap | null,
    imgUrl: null as string | null,
    like: null as Like | null,
    crop: { x: 0, y: 0, w: 1, h: 1 } as Crop,
    narrow: [] as string[],
    search: null as Search | null,
    cells: [] as Hit[],
    loading: false,
    stale: false,
    sug: -1,
    sugOpen: false,
    menu: null as null | 'mode' | 'set',
    viewer: -1,
    viewerOpen: false,
    vhit: null as Hit | null, // a Similar pick the viewer shows that isn't in the grid
    vflip: false,
    view: 'search' as 'search' | 'saved',
    savedFilter: 'all' as string,
    voteKey: '',
    prior: undefined as { up: Float32Array[]; down: Float32Array[] } | undefined,
    sketch: null as Skeleton | null, // the user's image read as a stick figure
    photoPose: null as Skeleton | null, // the user's photo read by MoveNet (Pose searches)
    grid: null as HTMLElement | null, // the results grid of the current search view
    unread: false, // a drawing we couldn't read as a stick figure (joints start on a template)
    sketchEdited: false, // the user dragged a joint: keep their joints, don't re-read
  };
  // each More like this is a history entry: hist[d] is the search at depth d (history.state.refsLike), for Back and Forward
  const hist: Snap[] = [];
  let histAt = (history.state as { refsLike?: number } | null)?.refsLike ?? 0;

  // ---- static skeleton
  const input = el('input', {
    id: 'r-q',
    type: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'r-sug',
    'aria-label': 'Describe the reference you need',
  });
  const ghost = el('div', { class: 'r-ghost', 'aria-hidden': 'true' });
  const modeBtn = el('button', {
    class: 'r-mode',
    type: 'button',
    id: 'r-modebtn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'data-tip': 'What are you looking for?',
  });
  const clearBtn = el('button', { class: 'r-clear', type: 'button', 'aria-label': 'Clear text', hidden: true }, ic('x'));
  const imgBtn = el(
    'button',
    { class: 'r-ib r-addimg', type: 'button', 'aria-label': 'Search with an image', 'data-tip': 'Search with an image' },
    ic('image'),
  );
  const setBtn = el(
    'button',
    {
      class: 'r-ib r-setbtn r-tip-end',
      type: 'button',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': 'Search settings',
      'data-tip': 'Search settings',
    },
    ic('sliders'),
  );
  const goBtn = el('button', { class: 'r-go', type: 'button', 'aria-label': 'Search' }, ic('search'));
  const sb = el(
    'div',
    { class: 'r-sb', role: 'search' },
    el('div', { class: 'r-bar' }, modeBtn, el('div', { class: 'r-inwrap' }, ghost, input), clearBtn, imgBtn, setBtn, goBtn),
  );
  const file = el('input', { type: 'file', accept: 'image/*', hidden: true, id: 'r-file' });
  const body = el('main', { class: 'r-main', id: 'r-main' });
  const page = el(
    'section',
    { class: 'r-page', 'aria-label': 'Find references', hidden: true },
    el('div', { class: 'r-barrow' }, sb),
    body,
    file,
  );
  root.append(page);
  // the sticky bar's height, for refs.css's scroll-padding (it wraps to two rows on phones)
  const barrow = sb.parentElement!;
  new ResizeObserver(() => document.documentElement.style.setProperty('--r-barrow-h', `${barrow.offsetHeight}px`)).observe(barrow);

  // ---------------------------------------------------------------- bar
  function guess(): Mode | null {
    if (S.mode !== 'auto' || !S.search || S.search === S.feed) return null; // the feed has no query to guess from
    return S.search.modeUsed() ?? null;
  }
  function paintMode() {
    const g = guess();
    modeBtn.replaceChildren(
      ic(S.mode === 'auto' ? 'auto' : S.mode),
      el('span', {}, MODE_LABEL[S.mode]),
      ...(g ? [el('span', { class: 'r-guess' }, `· ${MODE_LABEL[g]}`)] : []),
      ic('chev', 'r-chev'),
    );
    modeBtn.setAttribute('aria-label', `Search for: ${MODE_LABEL[S.mode]}${g ? `, guessing ${MODE_LABEL[g]}` : ''}`);
  }
  function paintBar() {
    paintMode();
    const hasImg = !!(S.bmp || S.like);
    input.placeholder = hasImg
      ? 'Add words, e.g. at night, from below'
      : COARSE
        ? 'Describe it, or add a photo'
        : 'Describe it, or paste an image';
    imgBtn.setAttribute('aria-label', hasImg ? 'Replace image' : 'Search with an image');
    imgBtn.dataset.tip = hasImg ? 'Replace image' : 'Search with an image';
    clearBtn.hidden = !S.q;
    setBtn.querySelector('.r-dot')?.remove();
    if (prefs.adult || prefs.off.length) setBtn.append(el('span', { class: 'r-dot' }));
    if (input.value !== S.q) input.value = S.q;
  }

  // ---- suggestions
  function sugRows(): Array<{ text: string; own?: boolean }> {
    if (!vocab || !S.q.trim()) return [];
    const typed = words(S.q).join(' '),
      own = resolveQuery(vocab, S.q),
      rows: Array<{ text: string; own?: boolean }> = [];
    // what Enter searches comes first, so the hint, Tab and Enter agree ("drago" → dragon, not dragonfly)
    if (corrected(S.q, own)) rows.push({ text: own, own: true });
    else if (own !== typed) rows.push({ text: own });
    // a whole word goes on as a phrase ("dragon skull") before it grows into another ("dragonfly"), and
    // once finished with a space only as a phrase; a plain English word ("drag") may be half of one
    const done = /\s$/.test(S.q),
      next = typed + ' ',
      whole = vocab.index.has(typed) && (done || vocab.catOf(typed) !== 'common');
    const comps = completions(vocab, S.q, 8).map((k) => display(vocab!, k));
    if (whole) comps.sort((a, b) => Number(!a.startsWith(next)) - Number(!b.startsWith(next)));
    for (const t of comps)
      if (t !== own && t !== typed && (!whole || t.startsWith(done ? next : typed)) && rows.length < 6) rows.push({ text: t });
    return rows;
  }
  function ghostText(): string {
    if (!S.sugOpen || S.sug >= 0 || !S.q.trim()) return '';
    const rows = sugRows();
    if (!rows.length || rows[0].own) return '';
    const low = S.q.toLowerCase();
    return rows[0].text.startsWith(low) ? rows[0].text.slice(low.length) : '';
  }
  function tabTarget(): string | null {
    const rows = sugRows();
    if (!S.sugOpen || !rows.length) return null;
    if (S.sug >= 0) return rows[S.sug].text;
    const g = ghostText();
    if (g) return S.q + g;
    return rows[0].own ? rows[0].text : null;
  }
  function refreshSug() {
    sb.querySelector('.r-sug')?.remove();
    const rows = S.sugOpen ? sugRows() : [];
    if (rows.length) {
      const rawWs = words(S.q),
        pq = vocab ? normWords(vocab, S.q, !/\s$/.test(S.q)).join(' ') : S.q;
      const list = el('ul', { class: 'r-sug', id: 'r-sug', role: 'listbox', 'aria-label': 'Suggestions' });
      rows.forEach((r, i) => {
        const body = el('span');
        if (r.own)
          words(r.text).forEach((w, j) => {
            if (j) body.append(' ');
            body.append(rawWs[j] && !w.startsWith(rawWs[j]) ? el('mark', {}, w) : w);
          });
        else if (r.text.startsWith(pq))
          body.append(el('span', { class: 'r-typed' }, r.text.slice(0, pq.length)), el('b', {}, r.text.slice(pq.length)));
        else body.append(r.text);
        const li = el(
          'li',
          { role: 'option', id: `r-sug-${i}`, 'aria-selected': String(i === S.sug) },
          ic('search'),
          body,
          r.own ? el('span', { class: 'r-note' }, 'fixed typo') : null,
        );
        li.addEventListener('pointerdown', (e) => e.preventDefault());
        li.addEventListener('click', () => run(r.text, { raw: S.q, exact: !r.own }));
        list.append(li);
      });
      list.append(
        el(
          'li',
          { class: 'r-foot', role: 'presentation', 'aria-hidden': 'true' },
          el('span', {}, el('kbd', {}, '↑'), el('kbd', {}, '↓'), ' choose'),
          tabTarget() ? el('span', {}, el('kbd', {}, 'Tab'), ' accept & keep typing') : null,
          el('span', {}, el('kbd', {}, 'Enter'), ' search'),
          el('span', {}, el('kbd', {}, 'Esc'), ' close'),
        ),
      );
      sb.append(list);
    }
    input.setAttribute('aria-expanded', String(rows.length > 0));
    if (S.sug >= 0 && rows.length) input.setAttribute('aria-activedescendant', `r-sug-${S.sug}`);
    else input.removeAttribute('aria-activedescendant');
    const g = ghostText();
    ghost.replaceChildren(...(g ? [el('span', { class: 'r-h' }, S.q), g] : []));
    clearBtn.hidden = !S.q;
  }
  input.addEventListener('input', () => {
    S.q = input.value;
    S.sugOpen = !!S.q.trim();
    S.sug = -1;
    refreshSug();
  });
  input.addEventListener('focus', () => {
    if (S.q.trim() && !S.ran) {
      S.sugOpen = true;
      refreshSug();
    }
  });
  input.addEventListener('keydown', (e) => {
    const rows = sugRows(),
      open = S.sugOpen && rows.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!S.sugOpen && S.q.trim()) {
        S.sugOpen = true;
        S.sug = rows.length ? 0 : -1;
      } else if (open) S.sug = (S.sug + 1) % rows.length;
      refreshSug();
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      S.sug = S.sug <= 0 ? rows.length - 1 : S.sug - 1;
      refreshSug();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      const v = tabTarget();
      if (v) {
        e.preventDefault();
        S.q = v + ' ';
        input.value = S.q;
        S.sug = -1;
        S.sugOpen = true;
        refreshSug();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (S.sug >= 0 && open) {
        const r = rows[S.sug];
        run(r.text, { raw: S.q, exact: !r.own });
      } else run(S.q);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (S.sugOpen) {
        S.sugOpen = false;
        S.sug = -1;
        refreshSug();
      }
    } else if (e.key === 'ArrowRight') {
      const g = ghostText();
      if (g && input.selectionStart === input.value.length) {
        e.preventDefault();
        S.q += g;
        input.value = S.q;
        refreshSug();
      }
    }
  });
  clearBtn.addEventListener('click', () => {
    S.q = '';
    input.value = '';
    S.sugOpen = false;
    refreshSug();
    input.focus();
  });
  goBtn.addEventListener('click', () => run(S.q));
  imgBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void setImageFile(f);
    file.value = '';
  });
  document.addEventListener('pointerdown', (e) => {
    if (page.hidden) return;
    const t = e.target as HTMLElement;
    if (S.sugOpen && !t.closest('.r-sb')) {
      S.sugOpen = false;
      S.sug = -1;
      refreshSug();
    }
    if (S.menu && !t.closest('.r-pop') && !t.closest('#r-modebtn') && !t.closest('.r-setbtn')) closePop(false);
  });

  // ---- popovers (mode menu, settings)
  function closePop(refocus = true) {
    if (!S.menu) return;
    const m = S.menu;
    S.menu = null;
    document.querySelectorAll('.r-pop').forEach((p) => p.remove());
    const b = m === 'mode' ? modeBtn : setBtn;
    b.setAttribute('aria-expanded', 'false');
    if (refocus) b.focus();
    paintBar();
  }
  function place(pop: HTMLElement, anchor: HTMLElement, alignRight: boolean) {
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    const left = alignRight ? r.right - pop.offsetWidth : r.left;
    pop.style.left = `${Math.max(8, Math.min(left, innerWidth - pop.offsetWidth - 8))}px`;
  }
  function trapTab(pop: HTMLElement, next: () => HTMLElement | null) {
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePop();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = [...pop.querySelectorAll<HTMLElement>('button, input')];
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        closePop(false);
        next()?.focus();
      } else if (e.shiftKey && i === 0) {
        e.preventDefault();
        closePop();
      }
    });
    pop.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !pop.contains(to)) closePop(false);
    });
  }
  function closeSug() {
    S.sugOpen = false;
    S.sug = -1;
    refreshSug();
  }
  modeBtn.addEventListener('click', () => {
    if (S.menu === 'mode') return closePop();
    closePop(false);
    closeSug(); // the menu opens where the suggestions are
    S.menu = 'mode';
    modeBtn.setAttribute('aria-expanded', 'true');
    const g = guess();
    const pop = el('div', { class: 'r-pop r-menu', role: 'menu', 'aria-label': 'What are you looking for?' });
    for (const m of MODES) {
      const b = el(
        'button',
        { type: 'button', role: 'menuitemradio', 'aria-checked': String(S.mode === m.id) },
        ic(m.id === 'auto' ? 'auto' : m.id),
        el('span', {}, m.label, el('span', { class: 'r-d' }, m.id === 'auto' && g ? `Picks for you · now ${MODE_LABEL[g]}` : m.d)),
        S.mode === m.id ? el('span', { class: 'r-ck' }, ic('check')) : null,
      );
      b.addEventListener('click', () => {
        S.mode = m.id;
        closePop();
        if (S.ran || S.bmp || S.like) {
          S.view = 'search'; // picked from Saved: show what it finds
          run(null);
        }
      });
      pop.append(b);
    }
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const b = [...pop.querySelectorAll('button')],
        i = b.indexOf(document.activeElement as HTMLButtonElement);
      b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length].focus();
    });
    trapTab(pop, () => input);
    place(pop, modeBtn, false);
    (pop.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  });
  let srcTimer = 0,
    startedAt = 0; // when the current search started: one started after a source change already has it
  setBtn.addEventListener('click', () => {
    if (S.menu === 'set') return closePop();
    closePop(false);
    closeSug();
    S.menu = 'set';
    setBtn.setAttribute('aria-expanded', 'true');
    const adult = el('input', { type: 'checkbox', class: 'r-sw', id: 'r-sw-adult' });
    adult.checked = prefs.adult;
    adult.addEventListener('change', () => {
      prefs.adult = adult.checked;
      savePrefs(prefs);
      resetFeed();
      if (S.ran || S.bmp || S.like) run(null);
      else paint();
    });
    const srcList = el('div', { class: 'r-srcs' });
    for (const s of SOURCES) {
      const cb = el('input', { type: 'checkbox', id: `r-src-${s.id}` });
      cb.checked = !prefs.off.includes(s.id);
      cb.addEventListener('change', () => {
        prefs.off = cb.checked ? prefs.off.filter((x) => x !== s.id) : [...prefs.off, s.id];
        savePrefs(prefs);
        // the results follow the new sources, once a few in a row have been ticked
        clearTimeout(srcTimer);
        const at = performance.now();
        srcTimer = window.setTimeout(() => {
          resetFeed();
          if (startedAt > at) return; // a search started since then already asks the new sources
          if (S.ran || S.bmp || S.like) run(null);
          else paint();
        }, 500);
      });
      srcList.append(el('label', { for: `r-src-${s.id}` }, cb, s.label));
    }
    const pop = el(
      'div',
      { class: 'r-pop r-settings', role: 'dialog', 'aria-label': 'Search settings' },
      el('h2', {}, 'Search settings'),
      el(
        'label',
        { class: 'r-row', for: 'r-sw-adult' },
        el('span', { class: 'r-l' }, 'Show adult content', el('small', {}, 'Off hides nudity and gore')),
        adult,
      ),
      el('h3', {}, 'Sources'),
      srcList,
    );
    trapTab(pop, () => goBtn);
    place(pop, setBtn, true);
    adult.focus();
  });

  // ---------------------------------------------------------------- search
  function snap(): Snap {
    const { sketch, photoPose, sketchEdited, unread } = S;
    return { q: S.q, ran: S.ran, bmp: S.bmp, imgUrl: S.imgUrl, like: S.like, crop: { ...S.crop }, mode: S.mode, narrow: [...S.narrow], sketch: sketch && { ...sketch }, photoPose, sketchEdited, unread };
  }
  function restore(s: Snap) {
    clearTimeout(cropTimer);
    Object.assign(S, { ...s, crop: { ...s.crop }, narrow: [...s.narrow], sketch: s.sketch && { ...s.sketch } });
    S.cells = [];
    if (page.hidden) {
      // Back/Forward while another page shows: show() runs it
      if (S.search !== S.feed) S.search?.abort();
      S.search = null;
      return;
    }
    run(null, { fresh: true });
  }

  /** run(text): a fresh search from the bar. run(null): same words; new crop / mode / narrowing. */
  function run(text: string | null, o: { raw?: string; exact?: boolean; fresh?: boolean } = {}) {
    closeSug();
    const resolve = (t: string, exact?: boolean) => (exact || !vocab ? t.trim() : resolveQuery(vocab, t));
    // new words start without the old narrowing; a mode, chip or crop change keeps what's on screen
    const same = text === null;
    if (same && S.q.trim() !== S.ran) {
      // the box was edited but not searched: search what it says now (an emptied box goes back instead)
      if (resolve(S.q) || (!S.q.trim() && (S.bmp || S.like))) text = S.q;
      else S.q = S.ran;
    }
    if (text !== null) {
      const raw = o.raw ?? text;
      const fin = resolve(text, o.exact);
      if (!fin && text.trim()) {
        // only emoji or symbols: nothing to search, so leave them in the box and say so
        toast('Try describing it in words');
        return;
      }
      S.fix = !o.exact && corrected(raw, fin) ? { from: raw.trim(), to: fin } : null;
      if (!same) {
        if (fin !== S.ran) S.narrow = [];
        S.view = 'search'; // searching from Saved shows the results
      }
      S.q = fin;
      S.ran = fin;
      S.narrow = S.narrow.filter((w) => !fin.includes(w));
      input.value = fin;
    } else S.fix = null;
    if (!o.fresh && S.like) S.like.seed = []; // More like this's first screen is the Similar strip; a refined search ranks afresh
    if (!S.ran && !S.bmp && !S.like) {
      if (S.search !== S.feed) S.search?.abort();
      S.search = null;
      S.cells = [];
      paint(); // the start screen, which picks the feed back up
      return;
    }
    // 👍/👎 survive narrowing, mode and crop changes; new words or a new image start fresh
    const key = `${S.ran}|${S.imgUrl ?? S.like?.key ?? ''}`;
    if (key === S.voteKey && S.search) S.prior = S.search.priorOut();
    else {
      S.prior = undefined;
      S.voteKey = key;
    }
    const stale = text === null && S.cells.length > 0 && !o.fresh && S.search !== S.feed; // the feed isn't a result to update
    void start(stale);
  }

  let startSeq = 0;
  async function start(stale: boolean) {
    const seq = ++startSeq;
    startedAt = performance.now();
    if (S.search && S.search === S.feed) S.feed.pause(); // kept for when you come back
    else S.search?.abort();
    if (S.bmp && !stale) {
      // reading the image can take seconds (the pose model's first load): show it, and that it's working
      S.search = null;
      S.cells = [];
      paint();
      if (S.grid) addSkeletons(S.grid);
    }
    const words_ = [S.ran, ...S.narrow].filter(Boolean).join(' ');
    let image: ImageBitmap | Float32Array | undefined;
    if (S.bmp) image = await cropped(S.bmp);
    else if (S.like) image = S.like.vec;
    if (seq !== startSeq) return; // a newer search started while this one was reading the image
    let pose: Skeleton | undefined,
      sketch = false;
    if (S.bmp && image instanceof ImageBitmap) {
      const read = await readPose(image, seq);
      pose = read.pose ?? undefined;
      sketch = read.sketch;
    }
    if (seq !== startSeq) return;
    const s = new Search({
      text: words_,
      mode: S.mode,
      adult: prefs.adult,
      image,
      mirror: prefs.mirror && !!S.bmp,
      hint: S.like?.title,
      exclude: S.like?.key,
      prior: S.prior ?? (S.like?.down.length ? { up: [], down: S.like.down } : undefined),
      seed: S.like?.seed,
      off: prefs.off,
      pose,
      sketch,
      drawing: !sketch && isDrawing(),
    });
    S.search = s;
    if (import.meta.env.DEV) (globalThis as { __refsSearch?: Search }).__refsSearch = s; // for the dev self-tests
    S.stale = stale;
    if (!stale) S.cells = [];
    let lastMode = s.modeUsed();
    s.onChange = () => {
      if (S.search === s && s.modeUsed() !== lastMode) {
        lastMode = s.modeUsed();
        const row = body.querySelector<HTMLElement>('.r-narrow');
        if (row && row.dataset.mode !== lastMode) row.replaceWith(narrowRow()); // chips follow the mode once it's known
      }
      if (S.search === s) {
        scheduleStatus();
        rankedLater();
      }
    };
    paint();
    // the sentinel may already be in view: re-observe so its callback fires for the new search
    io.unobserve(sentinel);
    io.observe(sentinel);
    void loadMore(true);
  }

  /** A drawing is read as a stick figure; a photo is read by MoveNet when searching for poses. */
  // Sketch joints are kept in whole-image coordinates (so the dots stay put when the crop changes)
  // and converted to the crop for searching.
  const toCrop = (sk: Skeleton): Skeleton => {
    const c = S.crop, m = (p: Pt): Pt => ({ x: (p.x - c.x) / c.w, y: (p.y - c.y) / c.h, c: p.c });
    const W = S.bmp?.width ?? 1, H = S.bmp?.height ?? 1;
    return { ...(Object.fromEntries(JOINTS.map((j) => [j, m(sk[j])])) as Record<(typeof JOINTS)[number], Pt>), from: 'sketch', aspect: (c.w * W) / (c.h * H) };
  };
  const toFull = (sk: Skeleton): Skeleton => {
    const c = S.crop, m = (p: Pt): Pt => ({ x: c.x + p.x * c.w, y: c.y + p.y * c.h, c: p.c });
    return { ...(Object.fromEntries(JOINTS.map((j) => [j, m(sk[j])])) as Record<(typeof JOINTS)[number], Pt>), from: 'sketch', aspect: (S.bmp?.width ?? 1) / (S.bmp?.height ?? 1) };
  };
  /** The image at up to 512px, as pixels. */
  function pixels(b: ImageBitmap): ImageData {
    const sc = Math.min(1, 512 / Math.max(b.width, b.height));
    const cv = new OffscreenCanvas(Math.max(1, Math.round(b.width * sc)), Math.max(1, Math.round(b.height * sc)));
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(b, 0, 0, cv.width, cv.height);
    return cx.getImageData(0, 0, cv.width, cv.height);
  }
  // Whether an image is a line drawing is judged once, on all of it: a pale corner of a painting can
  // look like paper, and cropping to it mustn't turn the painting into a stick figure.
  const drawing = new WeakMap<ImageBitmap, boolean>();
  const isDrawing = () => !!S.bmp && drawing.get(S.bmp) === true;
  /** A drawing is read as a stick figure (only when a pose is what's wanted: a house drawn in Place mode is
   *  searched as a house); a photo is read by MoveNet when searching for poses. */
  async function readPose(b: ImageBitmap, seq: number): Promise<{ pose: Skeleton | null; sketch: boolean }> {
    const figure = S.mode === 'pose' || S.mode === 'auto';
    if (figure && S.sketchEdited && S.sketch) return { pose: toCrop(S.sketch), sketch: true };
    if (S.bmp && !drawing.has(S.bmp)) drawing.set(S.bmp, looksLikeSketch(pixels(S.bmp)));
    const data = pixels(b);
    S.unread = false;
    let sk = figure && isDrawing() ? readSketch(data) : null;
    if (!sk && S.mode === 'pose' && isDrawing()) {
      // couldn't read it: start from a standing figure over the drawing; the user drags the dots into place
      const box = inkBox(data) ?? { x0: 0.3, y0: 0.1, x1: 0.7, y1: 0.9 };
      sk = templatePose(box, data.width / data.height);
      S.unread = true;
    }
    if (sk) {
      S.photoPose = null;
      S.sketch = toFull(sk);
      paintJoints();
      paintReading();
      return { pose: sk, sketch: true };
    }
    S.sketch = null;
    S.sketchEdited = false;
    paintJoints();
    const posey = S.mode === 'pose' || (S.mode === 'auto' && /pose|holding|stance|running|jump|kneel|lunge|sitting|fighting/.test(S.ran));
    if (!posey) {
      S.photoPose = null;
      paintReading();
      return { pose: null, sketch: false };
    }
    let photoPose: Skeleton | null = null;
    try {
      const e = await embedBitmap(await createImageBitmap(b), false, 1e9, true);
      photoPose = e.kps && e.pad ? fromMoveNet(e.kps, e.pad) : null;
    } catch {
      /* no figure read */
    }
    if (seq !== startSeq) return { pose: null, sketch: false }; // a newer search read the image meanwhile
    S.photoPose = photoPose;
    paintReading();
    return { pose: S.photoPose, sketch: false };
  }
  /** One line under the image saying how it was read. */
  function paintReading() {
    const pnl = body.querySelector('.r-panel');
    if (!pnl) return;
    pnl.querySelector('.r-reading')?.remove();
    if (S.sketch && S.unread && !S.sketchEdited)
      pnl.append(el('p', { class: 'r-reading' }, 'Couldn’t read this drawing by itself — drag the dots onto its head, joints, hands and feet'));
    else if (S.sketch)
      pnl.append(el('p', { class: 'r-reading' }, `Searching by this pose (${describePose(toCrop(S.sketch))[0]}) · drag a dot if a joint is off`));
    else if (S.photoPose) pnl.append(el('p', { class: 'r-reading' }, 'Matching the pose of the figure in your image'));
    else if (isDrawing()) {
      // a line drawing looks like few photos: words say what it's of
      const tip = S.mode !== 'auto' ? (S.ran ? '' : 'add a word or two to say what it is') : S.ran ? 'pick Pose to match a figure’s pose instead' : 'add a word or two to say what it is, or pick Pose for a figure’s pose';
      pnl.append(el('p', { class: 'r-reading' }, `Searching by how this drawing looks${tip ? ` · ${tip}` : ''}`));
    }
  }

  /** The sketch's joints as draggable dots over the image (arrow keys move the focused one). */
  function paintJoints() {
    const wrap = body.querySelector<HTMLElement>('.r-imgwrap');
    wrap?.querySelector('.r-joints')?.remove();
    if (!wrap || !S.sketch) return;
    const sk = S.sketch;
    const layer = el('div', { class: 'r-joints' });
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const lines = () => {
      svg.replaceChildren();
      for (const [a, b] of BONES) {
        const l = document.createElementNS(SVG, 'line');
        l.setAttribute('x1', String(sk[a].x * 100)); l.setAttribute('y1', String(sk[a].y * 100));
        l.setAttribute('x2', String(sk[b].x * 100)); l.setAttribute('y2', String(sk[b].y * 100));
        svg.append(l);
      }
    };
    lines();
    layer.append(svg);
    const dots = {} as Record<(typeof JOINTS)[number], HTMLButtonElement>;
    const place = (j: (typeof JOINTS)[number], x: number, y: number) => {
      sk[j] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), c: 1 };
      dots[j].style.left = `${sk[j].x * 100}%`; dots[j].style.top = `${sk[j].y * 100}%`;
      lines();
    };
    let drag: { j: (typeof JOINTS)[number]; sx: number; sy: number; dx: number; dy: number; moved: boolean } | null = null;
    for (const j of JOINTS) {
      const dot = el('button', { class: 'r-joint', type: 'button', 'aria-label': `${JOINT_LABEL[j]} — drag, or use arrow keys`, style: `left:${sk[j].x * 100}%;top:${sk[j].y * 100}%` });
      dots[j] = dot;
      dot.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); dot.setPointerCapture(e.pointerId);
        // the dots' grab areas overlap (the head sits just above the neck): take the joint nearest the press,
        // not the one drawn on top; of dots on the same spot, the top one, so they peel off in turn
        const r = wrap.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        const far = (k: (typeof JOINTS)[number]) => Math.hypot((sk[k].x - px) * r.width, (sk[k].y - py) * r.height);
        const k = JOINTS.reduce((a, b) => (far(b) <= far(a) ? b : a));
        drag = { j: k, sx: e.clientX, sy: e.clientY, dx: sk[k].x - px, dy: sk[k].y - py, moved: false };
        dots[k].focus({ preventScroll: true });
      });
      dot.addEventListener('pointermove', (e) => {
        if (!drag || (!drag.moved && e.clientX === drag.sx && e.clientY === drag.sy)) return;
        const r = wrap.getBoundingClientRect();
        place(drag.j, (e.clientX - r.left) / r.width + drag.dx, (e.clientY - r.top) / r.height + drag.dy);
        // edited from the first move, so a search already on its way keeps these joints instead of re-reading
        if (!drag.moved) { drag.moved = true; S.sketchEdited = true; clearTimeout(cropTimer); }
      });
      const end = () => { if (!drag) return; const moved = drag.moved; drag = null; if (!moved) return; S.unread = false; paintReading(); searchSoon(250); };
      dot.addEventListener('pointerup', end);
      dot.addEventListener('pointercancel', end);
      dot.addEventListener('keydown', (e) => {
        const k = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
        if (!k) return;
        e.preventDefault(); e.stopPropagation();
        place(j, sk[j].x + k[0] * 0.015, sk[j].y + k[1] * 0.015);
        S.sketchEdited = true; S.unread = false; paintReading(); searchSoon(600);
      });
      layer.append(dot);
    }
    wrap.append(layer);
  }

  async function cropped(b: ImageBitmap): Promise<ImageBitmap> {
    const c = S.crop;
    if (c.x <= 0.001 && c.y <= 0.001 && c.w >= 0.999 && c.h >= 0.999) return createImageBitmap(b);
    return createImageBitmap(
      b,
      Math.round(c.x * b.width),
      Math.round(c.y * b.height),
      Math.max(8, Math.round(c.w * b.width)),
      Math.max(8, Math.round(c.h * b.height)),
    );
  }

  let statusQueued = false;
  function scheduleStatus() {
    if (statusQueued) return;
    statusQueued = true;
    requestAnimationFrame(() => {
      statusQueued = false;
      paintStatus();
      paintMode();
    });
  }

  /** Loads the next batch for the current search. One load per search at a time; a new search
   *  never waits on the old one's load. Results always go into S.cells; the grid shows them when visible. */
  let loadingFor: Search | null = null;
  let loading: Promise<void> = Promise.resolve();
  function loadMore(first = false): Promise<void> {
    const s = S.search;
    if (!s) return Promise.resolve();
    if (loadingFor === s) return loading; // one at a time: wait for the one already loading (the viewer's Next)
    if (!first && s.status().exhausted) return Promise.resolve();
    loadingFor = s;
    return (loading = loadBatch(s));
  }
  async function loadBatch(s: Search) {
    if (!S.stale && S.grid?.isConnected) addSkeletons(S.grid);
    let hits: Hit[];
    try {
      hits = await s.next();
    } finally {
      if (loadingFor === s) loadingFor = null;
    }
    if (S.search !== s) return; // superseded while waiting
    if (S.stale) {
      S.stale = false;
      S.cells = [];
      S.grid?.replaceChildren();
      S.grid?.classList.remove('r-stale');
    }
    S.grid?.querySelectorAll('.r-skel').forEach((x) => x.remove());
    const showing = S.view === 'search' && !!S.grid?.isConnected;
    for (const h of hits) {
      const i = S.cells.push(h) - 1;
      if (showing) S.grid!.append(cell(h, i));
    }
    const done = s.status().exhausted;
    if (showing) {
      paintStatus();
      if (done && s !== S.feed) paintEnd(); // nothing found at all: the empty state
    }
    // a feed with nothing to show (every source switched off or out of reach) leaves no empty heading
    if (s === S.feed && done && !S.cells.length) body.querySelector<HTMLElement>('.r-feed')?.setAttribute('hidden', '');
    // keep filling while the bottom of the page is in view (next tick, never a tight loop)
    if (hits.length && !done && showing && sentinelVisible()) setTimeout(() => void loadMore(), 0);
    else if (!done) {
      // the observer only reports changes, and it may have missed the sentinel leaving and coming back
      // while this batch landed: a fresh look reports where it is now
      io.unobserve(sentinel);
      io.observe(sentinel);
    }
  }

  function addSkeletons(g: HTMLElement) {
    if (g.querySelector('.r-skel')) return;
    const ratios = [1.3, 0.75, 1, 1.5, 0.8, 1.2, 0.7, 1];
    for (let i = 0; i < (S.cells.length ? 4 : 8); i++)
      g.append(el('div', { class: 'r-skel', style: `aspect-ratio:${ratios[i]}`, 'aria-hidden': 'true' }));
  }

  // ---------------------------------------------------------------- painting
  function paint() {
    host.onSavedView(S.view === 'saved');
    paintBar();
    const src = S.imgUrl ?? S.like?.url;
    const kept = S.view === 'search' && !!src && shownPanel?.src === src && shownPanel.el.parentElement?.parentElement === body ? shownPanel : null;
    // all but the kept panel goes (taking it out, even to put it straight back, would drop its focus and drags)
    if (kept) [...body.children].forEach((n) => n !== kept.el.parentElement && n.remove());
    else body.replaceChildren();
    if (S.view === 'saved') return paintSaved();
    const hasSearch = !!(S.ran || S.bmp || S.like);
    if (!hasSearch) return paintStart();
    const wrap = kept?.el.parentElement ?? el('div');
    wrap.className = `r-body ${S.bmp || S.like ? 'r-has-img' : ''}`;
    [...wrap.children].forEach((n) => n !== kept?.el && n.remove());
    wrap.prepend(el('h1', { class: 'r-sr' }, `References${S.ran ? ` for ${S.ran}` : ''}`));
    if (kept) kept.sync();
    else if (S.bmp || S.like) wrap.append(panel());
    const col = el('div', { style: 'min-width:0' });
    col.append(metaLine(), narrowRow());
    const grid = masonry(el('div', { class: `r-grid${S.stale ? ' r-stale' : ''}` }));
    S.grid = grid;
    S.cells.forEach((h, i) => grid.append(cell(h, i, false)));
    col.append(grid, sentinel);
    wrap.append(col);
    if (!kept) body.append(wrap);
    if (S.search && S.search !== S.feed && !S.stale && S.search.status().exhausted) paintEnd(); // e.g. back from Saved
  }

  function paintStart() {
    const grid = el('div', { class: 'r-tiles' });
    body.append(
      el(
        'div',
        { class: 'r-ideas' },
        el('h1', {}, `Start with an idea — or ${COARSE ? 'add a photo' : `paste an image anywhere (${IS_MAC ? '⌘' : 'Ctrl'} V)`}`),
        grid,
      ),
    );
    const fill = (list: Tile[]) =>
      grid.replaceChildren(
        ...list.map(({ idea, img }, i) => {
          const im = el('img', { src: img, alt: '' });
          let next = 0;
          im.addEventListener('load', () => im.classList.add('r-ok'));
          im.addEventListener('error', () => {
            // a dead picture: show another of this idea's
            const alt = idea.imgs.filter((u) => u !== img)[next++];
            if (alt) im.src = alt;
          });
          const b = el('button', { class: 'r-tile', type: 'button', style: `background:${TONES[i % TONES.length]}` }, im, el('span', {}, idea.label));
          b.addEventListener('click', () => {
            S.mode = 'auto';
            run(idea.q, { exact: true });
          });
          return b;
        }),
      );
    paintFeed();
    if (S.tiles) return fill(S.tiles);
    // placeholders the size of the tiles while the list (a few KB) loads, so nothing jumps
    for (let i = 0; i < 8; i++) grid.append(el('div', { class: 'r-tile', style: `background:${TONES[i % TONES.length]}`, 'aria-hidden': 'true' }));
    void loadIdeas().then((pool) => {
      S.tiles ??= pickTiles(pool);
      if (grid.isConnected) fill(S.tiles);
    });
  }

  /** Under the ideas: an endless feed of new work (ArtStation trending, recent card art), a new mix
   *  every visit. It's the current "search" while the start screen shows, so the grid, the viewer and
   *  More like this work on it as on any results. */
  function paintFeed() {
    if (!S.feed) {
      const feed = new Search({ text: '', mode: 'auto', adult: prefs.adult, off: prefs.off, feed: seedFromBytes(crypto.getRandomValues(new Uint8Array(6))) });
      // some feed pictures show before the model has read them: one it then reads as adult is taken down
      feed.onChange = () => {
        if (S.search !== feed || !S.grid) return;
        const els = S.grid.querySelectorAll<HTMLElement>('.r-cell');
        S.feedCells.forEach((h, i) => {
          if (h.why === 'adult' && els[i]) els[i].hidden = true;
        });
        rankedLater();
      };
      S.feed = feed;
      S.feedCells = [];
    }
    S.search = S.feed;
    S.cells = S.feedCells;
    S.stale = false;
    if (import.meta.env.DEV) (globalThis as { __refsSearch?: Search }).__refsSearch = S.feed;
    S.feed.resume();
    const grid = masonry(el('div', { class: 'r-grid' }));
    S.grid = grid;
    S.cells.forEach((h, i) => grid.append(cell(h, i, false)));
    body.append(
      el(
        'section',
        { class: 'r-feed', 'aria-labelledby': 'r-feedhead' },
        el('h2', { id: 'r-feedhead' }, 'Fresh picks', el('small', {}, 'New on ArtStation and in card games · a new mix every visit')),
        grid,
        sentinel,
      ),
    );
    io.unobserve(sentinel);
    io.observe(sentinel);
    if (!S.cells.length) void loadMore(true);
  }
  function resetFeed() {
    if (S.search === S.feed) S.search = null;
    S.feed?.abort();
    S.feed = null;
    S.feedCells = [];
  }

  function metaLine() {
    const m = el('div', { class: 'r-meta' });
    if (S.fix) {
      const undo = el('button', { class: 'r-linkish', type: 'button' }, `search “${S.fix.from}” instead`);
      undo.addEventListener('click', () => S.fix && run(S.fix.from, { exact: true }));
      m.append(el('span', { class: 'r-fix' }, 'Showing ', el('b', {}, S.fix.to), ' · ', undo));
    }
    m.append(el('span', { class: 'r-status', id: 'r-status', role: 'status', 'aria-live': 'polite' }));
    queueMicrotask(paintStatus);
    return m;
  }
  function paintStatus() {
    const st = body.querySelector('#r-status');
    const s = S.search;
    if (st && !s && S.bmp) {
      // the image is still being read (see start); on a first visit the matching model may be downloading
      const vs = visionState();
      st.replaceChildren(el('span', { class: 'r-spin' }), `Reading your image…${vs.phase === 'loading' && vs.total ? ` · getting the matching model ready (${Math.min(99, Math.round((vs.loaded / vs.total) * 100))}%)` : ''}`);
      return;
    }
    if (!st || !s) return;
    const x = s.status(),
      n = s.picks();
    const tuned = n ? ` · tuned by ${n} pick${n > 1 ? 's' : ''}` : '';
    const shown = S.cells.filter((h) => h.why !== 'broken'); // a picture that won't load is hidden
    const srcs = new Set(shown.map((h) => h.c.src)).size;
    const from = `from ${srcs} source${srcs === 1 ? '' : 's'}`;
    const vs = visionState();
    // first visit only: say the matching model is downloading instead of looking stuck
    const model = vs.phase === 'loading' && vs.total ? ` · getting the matching model ready (${Math.min(99, Math.round((vs.loaded / vs.total) * 100))}%)` : '';
    st.replaceChildren();
    if (S.stale) st.append(el('span', { class: 'r-spin' }), 'Updating…');
    else if (!shown.length && !x.exhausted) {
      const asked = x.sourcesAsked ? `${x.sourcesAsked} source${x.sourcesAsked === 1 ? '' : 's'}` : 'sources';
      st.append(el('span', { class: 'r-spin' }), `Searching ${asked}…${model}`);
    }
    else if (x.nearest) st.append(`No close match for this pose · ${shown.length} nearest ${from} · drag a dot or add words to steer it`);
    else {
      const refs = `${shown.length} reference${shown.length === 1 ? '' : 's'} ${from}`;
      st.append(x.exhausted ? `${refs}${tuned}` : `${refs} · scroll for more${tuned}${model}`);
    }
  }
  let chipMode: Mode = 'pose'; // Auto keeps the last search's chips while a new one works out its mode
  function narrowRow() {
    const mode = (chipMode = (S.search !== S.feed && S.search?.modeUsed()) || (S.mode === 'auto' ? chipMode : S.mode));
    const inQ = S.ran.toLowerCase();
    const row = el('div', { class: 'r-narrow', 'aria-label': 'Narrow results', 'data-mode': mode }, el('span', { class: 'r-lbl' }, 'Narrow:'));
    for (const w of S.narrow) {
      const b = el('button', { class: 'r-chip r-on', type: 'button', 'aria-label': `Remove ${w}` }, w, ic('x'));
      b.addEventListener('click', () => {
        S.narrow = S.narrow.filter((x) => x !== w);
        run(null);
      });
      row.append(b);
    }
    for (const w of (NARROW[mode] ?? NARROW.pose).filter((x) => !S.narrow.includes(x) && !inQ.includes(x))) {
      const b = el('button', { class: 'r-chip', type: 'button' }, el('span', { class: 'r-p' }, '+'), w);
      b.addEventListener('click', () => {
        S.narrow.push(w);
        run(null);
      });
      row.append(b);
    }
    return row;
  }

  function cell(h: Hit, i: number, animate = true): HTMLElement {
    const c = h.c,
      v = S.search?.voteOf(c.key);
    const e = el('div', {
      class: `r-cell${v === 'up' ? ' r-liked' : ''}${v === 'down' ? ' r-nope' : ''}`,
      style: `--c:${TONES[i % TONES.length]};aspect-ratio:${Math.min(Math.max(c.aspect ?? 1, 0.6), 1.6)}`,
    });
    const img = el('img', { src: c.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.addEventListener('load', () => e.classList.add('r-loaded'));
    img.addEventListener('error', () => {
      if (!img.dataset.retried && !c.thumb.startsWith('https://wsrv.nl/')) {
        img.dataset.retried = '1';
        img.src = showUrl(c.thumb);
        return;
      }
      e.hidden = true;
      e.classList.add('r-broken');
      S.search?.broken(c.key);
      scheduleStatus();
    });
    const open = el(
      'button',
      {
        class: 'r-open',
        type: 'button',
        'aria-label': `${c.title}, ${SOURCE_BY_ID[c.src].label}. Open`,
        'aria-describedby': COARSE ? undefined : 'r-votehint',
      },
      img,
    );
    open.addEventListener('click', () => openViewer(i));
    const up = el(
      'button',
      { type: 'button', tabindex: '-1', 'aria-pressed': String(v === 'up'), 'aria-label': 'Good match', 'data-tip': 'Good match' },
      ic('up'),
    );
    const down = el(
      'button',
      {
        type: 'button',
        tabindex: '-1',
        'aria-pressed': String(v === 'down'),
        'aria-label': 'Not this',
        'data-tip': 'Not this',
        class: 'r-tip-end',
      },
      ic('down'),
    );
    up.addEventListener('click', () => vote(i, 'up'));
    down.addEventListener('click', () => vote(i, 'down'));
    const inFeed = !!S.search && S.search === S.feed; // "good match" means nothing without a query
    e.append(open);
    if (!inFeed) e.append(el('div', { class: 'r-votes' }, up, down));
    e.append(el('div', { class: 'r-cap' }, el('span', {}, c.title), el('span', {}, SOURCE_BY_ID[c.src].label)));
    // one Tab stop per result; ←/→ move between the card and its two ratings
    e.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const stops = [open, up, down],
        at = stops.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      ev.preventDefault();
      stops[Math.max(0, Math.min(2, at + (ev.key === 'ArrowRight' ? 1 : -1)))].focus();
    });
    if (animate) requestAnimationFrame(() => setTimeout(() => e.classList.add('r-in'), (i % 10) * 28));
    else e.classList.add('r-in');
    if (img.complete) e.classList.add('r-loaded');
    return e;
  }

  function vote(i: number, v: 'up' | 'down') {
    const h = S.cells[i],
      s = S.search;
    if (!h || !s) return;
    const now = s.voteOf(h.c.key) === v ? null : v;
    s.vote(h.c.key, now);
    const cellEl = document.querySelectorAll<HTMLElement>('.r-grid .r-cell')[i];
    cellEl?.classList.toggle('r-liked', now === 'up');
    cellEl?.classList.toggle('r-nope', now === 'down');
    cellEl
      ?.querySelectorAll('.r-votes button')
      .forEach((b, j) => b.setAttribute('aria-pressed', String((j === 0 ? 'up' : 'down') === now)));
    document
      .querySelectorAll('.r-viewer .r-pair[data-rate] button')
      .forEach((b, j) => b.setAttribute('aria-pressed', String((j === 0 ? 'up' : 'down') === now)));
    paintStatus();
    toast(now === 'up' ? 'Noted — next results lean this way' : now === 'down' ? 'Noted — fewer like this' : 'Removed');
  }

  function paintEnd() {
    const g = body.querySelector('.r-grid');
    if (!g || g.querySelector('.r-end')) return;
    const q = S.search?.plan?.text || S.ran;
    const links = el(
      'div',
      { class: 'r-links' },
      el(
        'a',
        { href: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`, target: '_blank', rel: 'noopener' },
        ic('ext'),
        'Pinterest',
      ),
      S.bmp || S.like
        ? el('a', { href: 'https://lens.google.com/', target: '_blank', rel: 'noopener' }, ic('ext'), 'Google Lens')
        : el(
            'a',
            { href: `https://www.google.com/search?udm=2&q=${encodeURIComponent(q)}`, target: '_blank', rel: 'noopener' },
            ic('ext'),
            'Google Images',
          ),
      el('a', { href: 'https://line-of-action.com/', target: '_blank', rel: 'noopener' }, ic('ext'), 'Line of Action'),
    );
    if (!S.cells.some((h) => h.why !== 'broken')) {
      body.querySelector('.r-body > div:last-child')?.replaceChildren(emptyState(links));
      return;
    }
    g.append(el('div', { class: 'r-end' }, 'That’s the closest we found. Keep looking with the same search on', links));
  }
  function emptyState(links: HTMLElement) {
    const auto = S.mode === 'auto';
    const x = S.search?.status();
    if (x?.failed) {
      const again = el('button', { class: 'r-chip', type: 'button' }, 'Try again');
      again.addEventListener('click', () => run(null, { fresh: true }));
      return el(
        'div',
        { class: 'r-empty' },
        el('h2', {}, S.bmp ? 'Image search isn’t available right now' : 'This search couldn’t start'),
        el('p', {}, S.bmp ? 'It needs the matching model, which couldn’t download. Check your connection and try again.' : 'Check your connection and try again.'),
        el('div', { class: 'r-narrow' }, again),
      );
    }
    const chips = el('div', { class: 'r-narrow' });
    const noSrc = !!x && !x.sourcesAsked, allOff = prefs.off.length >= SOURCES.length;
    if (noSrc) {
      const set = el('button', { class: 'r-chip', type: 'button' }, ic('sliders'), 'Search settings');
      set.addEventListener('click', () => setBtn.click());
      chips.append(set);
    }
    const used = S.search?.modeUsed();
    const modes: Mode[] = noSrc && allOff ? [] : auto ? (['pose', 'place', 'prop', 'creature'] as Mode[]).filter((m) => m !== used) : ['auto'];
    for (const m of modes) {
      const b = el(
        'button',
        { class: 'r-chip', type: 'button' },
        ic(m === 'auto' ? 'auto' : m),
        m === 'auto' ? 'Back to Auto' : MODE_LABEL[m],
      );
      b.addEventListener('click', () => {
        S.mode = m;
        run(S.ran, { exact: true });
      });
      chips.append(b);
    }
    return el(
      'div',
      { class: 'r-empty' },
      el('h2', {}, noSrc ? (allOff ? 'Every source is switched off' : `None of the sources you have on cover ${MODE_LABEL[used ?? S.mode]} searches`) : `No close matches for “${S.ran || 'this image'}”`),
      el('p', {}, noSrc ? `Turn ${allOff ? 'some' : 'more'} on in Search settings${modes.length ? ', or try another kind of search' : ''}:` : auto ? 'Try fewer words, or tell it what you’re after:' : 'Try fewer words, or let it pick for you:'),
      chips,
      el('div', { class: 'r-end' }, 'Or keep looking on', links),
    );
  }

  // infinite scroll
  const sentinel = el('div', { class: 'r-sentinel', 'aria-hidden': 'true' });
  const io = new IntersectionObserver(
    (es) => {
      if (es.some((x) => x.isIntersecting)) void loadMore();
    },
    { rootMargin: '1200px 0px' },
  );
  io.observe(sentinel);
  // edge contact counts, as it does for the observer (which then never reports it again)
  const sentinelVisible = () => {
    flow(); // place the batch just added before measuring
    return sentinel.isConnected && sentinel.getBoundingClientRect().top <= innerHeight + 1200;
  };

  // masonry: a cell goes under the shortest column when it arrives and keeps its place after (CSS columns
  // rebalanced every column on each batch), so ranks read left to right and a batch never moves what's on
  // screen. All of a column's cells share one grid area, each pushed down by the ones above it.
  let flowing: HTMLElement | null = null;
  const reflow = new MutationObserver(() => flow());
  const resized = new ResizeObserver(() => requestAnimationFrame(() => flow())); // after layout, not inside it
  function masonry(g: HTMLElement): HTMLElement {
    flowing = g;
    reflow.disconnect();
    reflow.observe(g, { childList: true, subtree: true, attributeFilter: ['hidden'] });
    resized.disconnect();
    resized.observe(g);
    return g;
  }
  function flow() {
    const g = flowing;
    if (!g?.isConnected) return;
    const cs = getComputedStyle(g),
      cols = cs.gridTemplateColumns.split(' ').map(parseFloat),
      w = cols[0],
      gap = parseFloat(cs.columnGap) || 0;
    if (!(w > 0)) return; // not laid out (the page is hidden): the resize observer flows it once it is
    const anew = g.dataset.cols !== String(cols.length); // first time, or a new column count: place everything
    g.dataset.cols = String(cols.length);
    const tall = cols.map(() => 0);
    for (const e of g.children as HTMLCollectionOf<HTMLElement>) {
      const ar = parseFloat(e.style.aspectRatio); // cells and skeletons; the end message spans the columns below
      if (e.hidden || !(ar > 0)) continue;
      let c = anew || !e.style.gridColumnStart ? -1 : +e.style.gridColumnStart - 1;
      if (c < 0) {
        c = tall.indexOf(Math.min(...tall));
        e.style.gridArea = `1 / ${c + 1}`;
      }
      const top = `${Math.round(tall[c] * 100) / 100}px`;
      if (e.style.marginTop !== top) e.style.marginTop = top;
      tall[c] += w / ar + gap;
    }
  }
  page.append(el('p', { class: 'r-sr', id: 'r-votehint' }, 'Press the right arrow key to rate this result.'));

  // ---------------------------------------------------------------- image panel
  function panel(): HTMLElement {
    const src = S.imgUrl ?? S.like?.url ?? '';
    const img = el('img', { src, alt: S.like ? `Searching like ${S.like.title}` : 'Your image', referrerpolicy: 'no-referrer' });
    const crop = el(
      'div',
      {
        class: 'r-crop',
        role: 'group',
        tabindex: '0',
        'aria-label': 'Search area. Drag, or use arrow keys to move and Shift plus arrows to resize.',
      },
      el('i', { 'data-h': 'nw' }),
      el('i', { 'data-h': 'ne' }),
      el('i', { 'data-h': 'sw' }),
      el('i', { 'data-h': 'se' }),
    );
    const wrap = el('div', { class: 'r-imgwrap' }, img, crop);
    // a small picture is drawn bigger (160px on its short side, as far as the stage allows), so the
    // handles don't cover it. The box is sized and the picture fills it, so the crop box (sized by the box)
    // always lies exactly over the picture; the width is capped so the height fits too, keeping its shape.
    const fit = (w: number, h: number) => {
      if (!w || !h) return;
      wrap.style.width = `min(${Math.round(w * Math.max(1, 160 / Math.min(w, h)))}px, 100%, calc(var(--r-imgmax, 60vh) * ${w / h}))`;
      img.style.width = '100%';
    };
    if (S.bmp) fit(S.bmp.width, S.bmp.height);
    else img.addEventListener('load', () => fit(img.naturalWidth, img.naturalHeight), { once: true });
    const applyCrop = () => {
      const c = S.crop;
      Object.assign(crop.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
      whole.setAttribute('aria-pressed', String(isWhole()));
      crop.classList.toggle('r-whole', isWhole()); // dragging on it draws a box, it doesn't move it
    };
    const isWhole = () => S.crop.w >= 0.999 && S.crop.h >= 0.999;
    const mirror = el('button', { class: 'r-toggle', type: 'button', 'aria-pressed': String(prefs.mirror) }, ic('mirror'), 'Mirrored too');
    mirror.addEventListener('click', () => {
      prefs.mirror = !prefs.mirror;
      savePrefs(prefs);
      mirror.setAttribute('aria-pressed', String(prefs.mirror));
      run(null);
    });
    const whole = el(
      'button',
      { class: 'r-ib', type: 'button', 'aria-label': 'Use whole image', 'data-tip': 'Use whole image' },
      ic('whole'),
    );
    whole.addEventListener('click', () => {
      if (isWhole()) return; // already searching all of it: a new search would only throw the results away
      S.crop = { x: 0, y: 0, w: 1, h: 1 };
      applyCrop();
      run(null);
    });
    const rm = el('button', { class: 'r-ib r-tip-end', type: 'button', 'aria-label': 'Remove image', 'data-tip': 'Remove image' }, ic('x'));
    rm.addEventListener('click', () => {
      hist.length = 0;
      clearImage();
      if (S.ran) run(S.ran, { exact: true });
      else {
        S.search?.abort();
        S.search = null;
        S.cells = [];
        paint();
      }
    });
    let hint: HTMLElement;
    if (S.like) {
      const back = el(
        'button',
        { class: 'r-back', type: 'button', 'aria-label': `Back to your previous search (now searching like ${S.like.title})` },
        '← Back · like ',
        el('b', {}, S.like.title),
      );
      back.addEventListener('click', () => history.back());
      hint = el('span', { class: 'r-hint' }, back);
    } else hint = el('span', { class: 'r-hint' }, 'Drag to search part of it');
    const tools = el('div', { class: `r-tools${S.like ? ' r-has-like' : ''}` }, hint, S.bmp ? mirror : null, whole, rm);
    applyCrop();
    bindCrop(crop, wrap, applyCrop);
    const pnl = el('div', { class: 'r-panel' }, el('div', { class: 'r-stage' }, wrap), tools);
    queueMicrotask(() => { paintJoints(); paintReading(); });
    shownPanel = {
      src,
      el: pnl,
      sync: () => {
        applyCrop();
        if (S.bmp && !mirror.isConnected) whole.before(mirror); // a "More like this" picture fetched for cropping
      },
    };
    return pnl;
  }
  /** The image panel on screen. A new search of the same image keeps it in place rather than drawing a new
   *  one, so a drag on it, or keyboard focus on its crop box or a joint, carries on through the search. */
  let shownPanel: { src: string; el: HTMLElement; sync: () => void } | null = null;

  let cropTimer = 0;
  const searchSoon = (ms = 320) => {
    clearTimeout(cropTimer);
    cropTimer = window.setTimeout(() => void cropChanged(), ms);
  };
  async function cropChanged() {
    // a crop of a "More like this" image needs its pixels: fetch it once through wsrv.nl
    if (S.like && !S.bmp) {
      const key = S.like.key;
      let bmp: ImageBitmap;
      try {
        const r = await fetch(
          `https://wsrv.nl/?url=${encodeURIComponent(S.like.url.replace(/^https?:\/\//, ''))}&w=1024&h=1024&fit=inside&output=jpg`,
        );
        bmp = await createImageBitmap(await r.blob());
      } catch {
        if (S.like?.key === key) toast('Couldn’t load that image to crop it');
        return;
      }
      if (S.like?.key !== key || S.bmp) return bmp.close(); // went Back (or elsewhere) while it loaded
      S.bmp = bmp;
    }
    run(null);
  }
  // from where a new box was started toward the pointer: at least `min` long, inside the picture
  const span = (a: number, d: number, min: number): [number, number] => {
    const lo = d < 0 ? Math.min(Math.max(a, min) - min, Math.max(0, a + d)) : Math.min(a, 1 - min);
    return [lo, (d < 0 ? Math.max(a, min) : Math.max(lo + min, Math.min(1, a + d))) - lo];
  };
  // a side drawn under 40px (a 4000x120 banner is an 11px strip) can't be cropped: the box always spans it
  const spanThin = (c: Crop, W: number, H: number): Crop => ({ ...c, ...(W < 40 ? { x: 0, w: 1 } : {}), ...(H < 40 ? { y: 0, h: 1 } : {}) });
  function bindCrop(crop: HTMLElement, wrap: HTMLElement, apply: () => void) {
    // …and its handles sit off the strip rather than covering it
    new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      wrap.classList.toggle('r-thin-x', r.width > 0 && r.width < 40);
      wrap.classList.toggle('r-thin-y', r.height > 0 && r.height < 40);
    }).observe(wrap);
    let drag: { h: string; sx: number; sy: number; c: Crop; W: number; H: number; ax: number; ay: number; moved: boolean } | null = null;
    // a press anywhere on the picture: a handle resizes the box, inside it moves it, anywhere else (or on
    // a box that's still the whole picture) draws a new one
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      const r = wrap.getBoundingClientRect(),
        t = e.target as HTMLElement;
      drag = {
        h: t.closest('i')?.dataset.h ?? (crop.contains(t) && !(S.crop.w >= 0.999 && S.crop.h >= 0.999) ? 'move' : 'draw'),
        sx: e.clientX,
        sy: e.clientY,
        c: { ...S.crop },
        W: r.width,
        H: r.height,
        ax: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        ay: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
        moved: false,
      };
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.sx) / drag.W,
        dy = (e.clientY - drag.sy) / drag.H,
        min = 0.12;
      let { x, y, w, h } = drag.c;
      if (drag.h === 'draw') {
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return; // a click isn't a box
        [x, w] = span(drag.ax, dx, min);
        [y, h] = span(drag.ay, dy, min);
      } else if (drag.h === 'move') {
        x = Math.min(Math.max(0, x + dx), 1 - w);
        y = Math.min(Math.max(0, y + dy), 1 - h);
      } else {
        if (drag.h.includes('w')) {
          const nx = Math.min(Math.max(0, x + dx), x + w - min);
          w += x - nx;
          x = nx;
        }
        if (drag.h.includes('e')) w = Math.min(Math.max(min, w + dx), 1 - x);
        if (drag.h.includes('n')) {
          const ny = Math.min(Math.max(0, y + dy), y + h - min);
          h += y - ny;
          y = ny;
        }
        if (drag.h.includes('s')) h = Math.min(Math.max(min, h + dy), 1 - y);
      }
      ({ x, y, w, h } = spanThin({ x, y, w, h }, drag.W, drag.H));
      if (JSON.stringify({ x, y, w, h }) === JSON.stringify(S.crop)) return;
      // a search still due from the last change waits for this one (a press that changes nothing leaves it be)
      if (!drag.moved) clearTimeout(cropTimer);
      drag.moved = true;
      S.crop = { x, y, w, h };
      apply();
    });
    const end = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) searchSoon();
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    crop.addEventListener('keydown', (e) => {
      const k = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
      if (!k) return;
      e.preventDefault();
      const c = { ...S.crop },
        st = 0.02;
      if (e.shiftKey) {
        c.w = Math.min(Math.max(0.12, c.w + k[0] * st), 1 - c.x);
        c.h = Math.min(Math.max(0.12, c.h + k[1] * st), 1 - c.y);
      } else {
        c.x = Math.min(Math.max(0, c.x + k[0] * st), 1 - c.w);
        c.y = Math.min(Math.max(0, c.y + k[1] * st), 1 - c.h);
      }
      const r = wrap.getBoundingClientRect(),
        next = spanThin(c, r.width, r.height);
      if (JSON.stringify(next) === JSON.stringify(S.crop)) return; // at the edge already: nothing to search again
      S.crop = next;
      apply();
      searchSoon(600);
    });
  }

  function clearImage() {
    if (S.imgUrl) URL.revokeObjectURL(S.imgUrl);
    S.bmp?.close?.();
    S.bmp = null;
    S.imgUrl = null;
    S.like = null;
    S.narrow = [];
    S.sketch = null;
    S.photoPose = null;
    S.sketchEdited = false;
    S.unread = false;
  }
  /** Transparent parts as white paper: line art saved without a background is dark strokes on nothing,
   *  which the drawing check, the pose reader and the model would all see as black on black. */
  async function onPaper(b: ImageBitmap): Promise<ImageBitmap> {
    const probe = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true })!;
    probe.drawImage(b, 0, 0, 64, 64);
    const a = probe.getImageData(0, 0, 64, 64).data;
    let clear = false;
    for (let i = 3; i < a.length && !clear; i += 4) clear = a[i] < 250;
    if (!clear) return b;
    const cv = new OffscreenCanvas(b.width, b.height), cx = cv.getContext('2d')!;
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(b, 0, 0);
    b.close();
    return createImageBitmap(cv);
  }
  let imgSeq = 0;
  async function setImageFile(f: File) {
    if (f.type && !f.type.startsWith('image/')) {
      toast('That isn’t an image: use a PNG, JPG or WebP');
      return;
    }
    const my = ++imgSeq;
    let bmp: ImageBitmap;
    try {
      bmp = await onPaper(await createImageBitmap(f));
    } catch {
      if (my === imgSeq) toast('That file isn’t an image this browser can read');
      return;
    }
    if (my !== imgSeq) {
      bmp.close(); // another image came in while this one decoded: the last one in wins
      return;
    }
    if (S.viewerOpen) requestClose(); // its picture, count and ratings belong to the results being replaced
    hist.length = 0;
    clearImage();
    S.bmp = bmp;
    S.imgUrl = URL.createObjectURL(f);
    S.crop = { x: 0, y: 0, w: 1, h: 1 }; // whole image first; drag in to search part of it
    S.cells = [];
    S.view = 'search';
    if (S.q.trim()) run(S.q, { exact: true });
    else {
      S.ran = '';
      run(null, { fresh: true });
    }
  }
  // paste anywhere and drop anywhere, while this page is showing
  document.addEventListener('paste', (e) => {
    if (page.hidden) return;
    const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      void setImageFile(f);
    }
  });
  let depth = 0;
  // the "drop to search" overlay only for an image (a file's type is known before the drop; its name isn't)
  const imageDrag = (dt: DataTransfer | null) => {
    const fs = [...(dt?.items ?? [])].filter((x) => x.kind === 'file');
    return fs.length ? fs.some((x) => !x.type || x.type.startsWith('image/')) : [...(dt?.types ?? [])].includes('Files');
  };
  document.addEventListener('dragenter', (e) => {
    if (page.hidden || !imageDrag(e.dataTransfer)) return;
    depth++;
    document.body.classList.add('r-dropping');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('r-dropping');
    }
  });
  document.addEventListener('dragover', (e) => {
    if (!page.hidden) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (page.hidden) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('r-dropping');
    const fs = [...(e.dataTransfer?.files ?? [])];
    const f = fs.find((x) => x.type.startsWith('image/')) ?? fs[0]; // not an image: it says so
    if (f) void setImageFile(f);
  });

  // ---------------------------------------------------------------- viewer
  let viewerList: () => Cand[] = () => S.cells.map((h) => h.c);
  /** Grid positions it hides (a picture that won't load, a feed picture read as adult): the viewer skips them too. */
  function hiddenCells(): boolean[] {
    return S.view === 'search' && S.grid ? [...S.grid.querySelectorAll<HTMLElement>('.r-cell')].map((e) => !!e.hidden) : [];
  }
  function openViewer(i: number, list?: () => Cand[]) {
    if (!(list ?? (() => S.cells))()[i]) return; // a cell of results already replaced: nothing to show, so no history entry or scroll lock
    viewerList = list ?? (() => S.cells.map((h) => h.c));
    S.viewer = i;
    S.vhit = null;
    S.vflip = false;
    if (!S.viewerOpen) {
      S.viewerOpen = true;
      history.scrollRestoration = 'manual'; // closing focuses the result you ended on: don't scroll back to where you opened
      history.pushState({ refsViewer: 1, refsLike: histAt }, '');
    }
    document.documentElement.classList.add('r-noscroll');
    renderViewer();
  }
  function requestClose() {
    if (S.viewerOpen) history.back();
    else closeViewer();
  }
  function closeViewer() {
    const i = S.viewer;
    const key = viewerList()[i]?.key;
    S.viewer = -1;
    S.vhit = null;
    S.viewerOpen = false;
    document.documentElement.classList.remove('r-noscroll');
    document.querySelector('.r-viewer')?.remove();
    toastHost(null);
    (document.getElementById('app') as HTMLElement).inert = false;
    if (i < 0) return;
    // by key in Saved (its grid may have repainted while the viewer was open); in results, the result you
    // ended on, or the nearest one the grid still shows
    if (S.view === 'saved') return focusSaved(key, i);
    const opens = [...body.querySelectorAll<HTMLElement>('.r-grid .r-open')],
      shown = (o: HTMLElement) => o.offsetParent !== null;
    (opens.slice(i).find(shown) ?? opens.slice(0, i).reverse().find(shown))?.focus();
  }
  function moveViewer(n: number) {
    const list = viewerList(),
      off = hiddenCells();
    let i = S.viewer + (S.vhit && n < 0 ? 0 : n); // from a Similar pick, ← goes back to the result you came from
    while (off[i]) i += n < 0 ? -1 : 1;
    if (i < 0) return;
    if (i >= list.length) {
      if (S.view === 'search' && S.search && !S.search.status().exhausted) {
        const at = S.viewer,
          from = S.vhit,
          next = document.getElementById('r-vnext');
        next?.setAttribute('aria-busy', 'true');
        void loadMore()
          .catch(() => undefined)
          .then(() => {
            next?.removeAttribute('aria-busy');
            // closed, or moved elsewhere, while the batch loaded: stay put
            if (S.viewerOpen && S.viewer === at && S.vhit === from && i < viewerList().length) moveViewer(n);
          });
      }
      return;
    }
    S.viewer = i;
    S.vhit = null;
    S.vflip = false;
    const id = (document.activeElement as HTMLElement | null)?.id;
    renderViewer();
    if (id === 'r-vprev' || id === 'r-vnext')
      ((document.getElementById(id) as HTMLButtonElement | null)?.disabled
        ? document.getElementById('r-vcard')
        : document.getElementById(id)
      )?.focus();
  }
  function renderViewer() {
    document.querySelector('.r-viewer')?.remove();
    const list = viewerList(),
      c = S.vhit?.c ?? list[S.viewer];
    if (!c || !S.viewerOpen) {
      // closed meanwhile (e.g. while a batch loaded): never reopen without its history entry. Open with
      // nothing left to show: close it properly (its history entry, the scroll lock); S.viewer stays set so
      // the popstate closes the viewer instead of going back a search
      if (S.viewerOpen) requestClose();
      else S.viewer = -1;
      return;
    }
    const inSearch = S.view === 'search';
    const hit = inSearch ? S.vhit ?? S.cells[S.viewer] : undefined;
    // counted as the grid shows them: without the ones it hid
    const off = hiddenCells(),
      pos = S.viewer + 1 - off.slice(0, S.viewer).filter(Boolean).length,
      after = list.some((_, k) => k > S.viewer && !off[k]);
    const total = S.vhit
      ? 'Similar'
      : `${pos} of ${list.length - off.filter(Boolean).length}${inSearch && S.search && !S.search.status().exhausted ? '+' : ''}`;
    const v = hit ? S.search?.voteOf(c.key) : undefined;
    const big = c.full || c.thumb;
    const img = el('img', { src: big, alt: c.title, referrerpolicy: 'no-referrer' });
    // as the grid does: the thumbnail, then through wsrv.nl (hosts that refuse or rate-limit); then say so
    const alts = [c.thumb, ...(big.startsWith('https://wsrv.nl/') ? [] : [showUrl(big, 1280)])].filter((u) => u !== big);
    img.addEventListener('error', () => {
      const u = alts.shift();
      if (u) img.src = u;
      else img.replaceWith(el('p', { class: 'r-vfail' }, 'Couldn’t load this picture'));
    });
    const prev = el(
      'button',
      { class: 'r-vnav r-prev', id: 'r-vprev', type: 'button', 'aria-label': 'Previous', disabled: !S.vhit && pos === 1 },
      ic('left'),
    );
    const next = el(
      'button',
      {
        class: 'r-vnav r-next',
        id: 'r-vnext',
        type: 'button',
        'aria-label': 'Next',
        disabled: !after && (!inSearch || !!S.search?.status().exhausted),
      },
      ic('right'),
    );
    prev.addEventListener('click', () => moveViewer(-1));
    next.addEventListener('click', () => moveViewer(1));
    const pic = el('div', { class: `r-pic${S.vflip ? ' r-flipped' : ''}` }, img, el('span', { class: 'r-vcount' }, total), prev, next);
    let sx: number | null = null;
    pic.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') sx = e.clientX;
    });
    pic.addEventListener('pointerup', (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx;
      sx = null;
      if (Math.abs(dx) > 50) moveViewer(dx < 0 ? 1 : -1);
    });
    const close = el('button', { class: 'r-ib r-vclose', type: 'button', 'aria-label': 'Close' }, ic('x'));
    close.addEventListener('click', requestClose);
    const back = el('button', { class: 'r-vback', type: 'button' }, ic('left'), 'Back to results');
    back.addEventListener('click', requestClose);
    const side = el(
      'div',
      { class: 'r-vside' },
      el(
        'div',
        { class: 'r-vhead' },
        el(
          'div',
          {},
          el('h2', {}, c.title),
          el('div', { class: 'r-by' }, `${c.artist ? `${c.artist} · ` : ''}${SOURCE_BY_ID[c.src].label}`),
        ),
        close,
      ),
    );
    const inFeed = !!S.search && S.search === S.feed;
    if (hit && !inFeed && !S.vhit) {
      const up = el('button', { type: 'button', 'aria-pressed': String(v === 'up') }, ic('up'), 'Good match');
      const dn = el('button', { type: 'button', 'aria-pressed': String(v === 'down') }, ic('down'), 'Not this');
      up.addEventListener('click', () => vote(S.viewer, 'up'));
      dn.addEventListener('click', () => vote(S.viewer, 'down'));
      side.append(el('div', { class: 'r-pair', role: 'group', 'aria-label': 'Rate this match', 'data-rate': '1' }, up, dn));
    }
    const isSaved = !!saved[c.key];
    const save = el('button', { type: 'button', 'aria-pressed': String(isSaved) }, ic('star'), isSaved ? 'Saved' : 'Save');
    save.addEventListener('click', () => toggleSave(c, save));
    const flip = el('button', { type: 'button', 'aria-pressed': String(S.vflip) }, ic('flip'), 'Flip');
    flip.addEventListener('click', () => {
      S.vflip = !S.vflip;
      flip.setAttribute('aria-pressed', String(S.vflip));
      pic.classList.toggle('r-flipped', S.vflip);
    });
    side.append(
      el('div', { class: 'r-pair' }, save, flip),
      el('a', { class: 'r-vlink', href: /^https?:\/\//.test(c.page) ? c.page : '#', target: '_blank', rel: 'noopener noreferrer' }, ic('ext'), `Open on ${SOURCE_BY_ID[c.src].label}`),
    );
    if (hit) viewerRanked(side, hit);
    const card = el(
      'div',
      { class: 'r-vcard', id: 'r-vcard', tabindex: '-1' },
      el('div', { class: 'r-vbar' }, back, el('span', { class: 'r-vpos' }, total)),
      pic,
      side,
    );
    const ov = el('div', { class: 'r-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': c.title }, card);
    let downOn: EventTarget | null = null;
    ov.addEventListener('pointerdown', (e) => (downOn = e.target));
    ov.addEventListener('click', (e) => {
      if (e.target !== ov) return;
      // a press that began on the backdrop, and not the second click of the double-click that opened this
      if (downOn === ov && e.detail < 2) requestClose();
      else card.focus(); // the press took focus out of the dialog: Esc and arrows must still work
    });
    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
      } else if (e.key === 'ArrowRight') moveViewer(1);
      else if (e.key === 'ArrowLeft') moveViewer(-1);
      else if (e.key === 'Tab') {
        const f = [...ov.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')].filter((x) => x.offsetParent !== null);
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1]?.focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0]?.focus();
        }
      }
    });
    document.body.append(ov);
    toastHost(ov);
    (document.getElementById('app') as HTMLElement).inert = true;
    card.focus();
  }
  /** More like this and the Similar strip need the result's vector, which can arrive after the viewer opened. */
  function viewerRanked(side: HTMLElement, hit: Hit) {
    if (hit.vec && !side.querySelector('.r-primary')) {
      const more = el('button', { class: 'r-primary', type: 'button' }, ic('layers'), 'More like this');
      more.addEventListener('click', () => moreLikeThis(hit));
      side.querySelector('.r-vhead')?.after(more);
    }
    if (!S.search || S.search === S.feed || side.querySelector('.r-mini')) return;
    const near = S.search.similar(hit.c.key, 6);
    if (!near.length) return;
    const all = el('button', { class: 'r-linkish', type: 'button' }, 'See all');
    all.addEventListener('click', () => moreLikeThis(hit));
    const mini = el('div', { class: 'r-mini' });
    for (const n of near) {
      const im = el('img', { src: n.c.thumb, alt: '', referrerpolicy: 'no-referrer' });
      im.addEventListener('error', () => {
        if (!im.dataset.retried && !n.c.thumb.startsWith('https://wsrv.nl/')) {
          im.dataset.retried = '1';
          im.src = showUrl(n.c.thumb);
        } else b.hidden = true;
      });
      const b = el('button', { type: 'button', 'aria-label': n.c.title }, im);
      b.addEventListener('click', () => {
        const j = S.cells.indexOf(n);
        S.vflip = false;
        S.vhit = j >= 0 ? null : n; // not in the grid: shown all the same; ← goes back to where you were
        if (j >= 0) S.viewer = j;
        renderViewer();
      });
      mini.append(b);
    }
    side.append(el('div', {}, el('div', { class: 'r-nearhead' }, el('span', {}, 'Similar'), all), mini));
  }
  /** The open viewer's result got ranked (the model was still loading when it opened): add what that allows. */
  function rankedLater() {
    const side = document.querySelector<HTMLElement>('.r-viewer .r-vside'),
      hit = S.vhit ?? S.cells[S.viewer];
    if (side && S.viewerOpen && S.view === 'search' && hit) viewerRanked(side, hit);
  }
  addEventListener('popstate', () => {
    const st = history.state as { refsViewer?: number; refsLike?: number } | null;
    if (S.viewer >= 0) closeViewer();
    else if (st?.refsViewer) return history.back(); // Forward onto a viewer that was closed since: step off it
    const d = st?.refsLike ?? 0;
    if (d === histAt || !hist[d]) return;
    hist[histAt] = snap(); // so Forward (or Back) can return to it
    histAt = d;
    hideToast(); // its Undo was for the search just left
    restore(hist[d]);
  });

  function moreLikeThis(hit: Hit) {
    if (!hit.vec || !S.search) return;
    // the feed is a random mix: its "nearest" pictures aren't similar, so there's nothing to start from
    const seed = S.search === S.feed ? [] : S.search.similar(hit.c.key, 6);
    const reuse = S.viewerOpen; // the viewer's history entry becomes this search's
    closeViewer();
    clearTimeout(cropTimer);
    hist[histAt] = snap();
    hist.length = ++histAt; // a new branch: what Forward had is gone, as in the browser
    if (reuse) history.replaceState({ refsLike: histAt }, '');
    else history.pushState({ refsLike: histAt }, '');
    const at = histAt;
    if (S.imgUrl) {
      /* keep the user's image alive for Back: don't revoke */
    }
    S.bmp = null;
    S.imgUrl = null;
    S.like = { title: hit.c.title, key: hit.c.key, vec: hit.vec, url: hit.c.full || hit.c.thumb, seed, down: S.search.priorOut().down };
    S.crop = { x: 0, y: 0, w: 1, h: 1 };
    S.narrow = [];
    // not a drawing's pose: this searches by how the result looks
    S.sketch = null;
    S.photoPose = null;
    S.sketchEdited = false;
    S.unread = false;
    S.cells = [];
    S.fix = null;
    run(null, { fresh: true });
    const undo = () => {
      // only while this search is the one showing (after Back, a second back() would leave the app)
      const st = history.state as { refsViewer?: number; refsLike?: number } | null;
      if (st?.refsLike === at) history.go(st.refsViewer ? -2 : -1);
    };
    toast(COARSE ? 'Searching like this' : `Searching like “${hit.c.title}”`, { action: { label: 'Undo', run: undo } });
  }

  // ---------------------------------------------------------------- saved references
  const removed: Record<string, SavedRef> = {}; // un-saved this visit: saving again puts it back in its folder
  function toggleSave(c: Cand, btn?: HTMLElement) {
    if (saved[c.key]) {
      const undone = () => {
        if (btn?.isConnected) paintSaveBtn(btn, true);
      };
      if (removeSaved(c.key, undone)) paintSaveBtn(btn, false);
    } else if (putSaved(c.key, removed[c.key] ?? refFrom(c, undefined))) {
      delete removed[c.key];
      paintSaveBtn(btn, true);
      toast('Saved', {
        action: {
          label: 'View',
          run: () => {
            if (S.viewerOpen) history.back();
            setTimeout(() => showSaved(true), 60);
          },
        },
      });
    }
  }
  function paintSaveBtn(btn: HTMLElement | undefined, on: boolean) {
    btn?.setAttribute('aria-pressed', String(on));
    btn?.replaceChildren(ic('star'), on ? 'Saved' : 'Save');
  }
  /** Removes a saved reference, with Undo. Only ever removes: false when it isn't saved or the write is refused. */
  function removeSaved(key: string, onUndo?: () => void): boolean {
    const was = saved[key];
    if (!was || !putSaved(key, undefined)) return false;
    removed[key] = was;
    toast('Removed from Saved', {
      action: {
        label: 'Undo',
        run: () => {
          if (saved[key] || !putSaved(key, was)) return;
          delete removed[key];
          onUndo?.();
        },
      },
    });
    return true;
  }
  /** Sets (or, with undefined, removes) one saved reference. A refused write changes nothing. */
  function putSaved(key: string, ref: SavedRef | undefined): boolean {
    const was = saved[key];
    if (ref) saved[key] = ref;
    else delete saved[key];
    if (!persistSaved()) {
      if (was) saved[key] = was;
      else delete saved[key];
      return false;
    }
    if (S.view === 'saved') paint(); // also under the viewer, so closing it never shows a stale grid
    return true;
  }
  /** Writes the saved list; false (with a message) when the browser refuses — nothing is claimed saved then. */
  function persistSaved(): boolean {
    const ok = saveRefs(saved);
    if (ok) host.onSavedChange(Object.keys(saved).length);
    else toast('Couldn’t save: this browser is blocking storage (private window, or storage full)');
    return ok;
  }
  /** Focus after the Saved grid repaints: the item's own control, else the cell now in its place, else its folder chip. */
  function focusSaved(key: string | undefined, i: number, sel = '.r-open') {
    const cells = [...body.querySelectorAll<HTMLElement>('.r-saved .r-cell')];
    (
      cells.find((x) => x.dataset.key === key)?.querySelector<HTMLElement>(sel) ??
      (cells[i] ?? cells[i - 1])?.querySelector<HTMLElement>('.r-open') ??
      body.querySelector<HTMLElement>('.r-saved .r-chip.r-on')
    )?.focus();
  }
  function showSaved(on: boolean) {
    S.view = on ? 'saved' : 'search';
    paint();
    window.scrollTo({ top: 0 });
  }
  function paintSaved() {
    const folders = host.folders();
    const all = Object.values(saved).sort((a, b) => b.savedAt - a.savedAt);
    if (S.savedFilter !== 'all' && S.savedFilter !== 'unsorted' && !folders.some((f) => f.id === S.savedFilter)) S.savedFilter = 'all';
    const list = all.filter(
      (r) =>
        S.savedFilter === 'all' ||
        (S.savedFilter === 'unsorted' ? !r.folder || !folders.some((f) => f.id === r.folder) : r.folder === S.savedFilter),
    );
    const back = el('button', { class: 'r-linkish', type: 'button' }, '← Back to search');
    back.addEventListener('click', () => showSaved(false));
    const chips = el('div', { class: 'r-folders', role: 'group', 'aria-label': 'Folders' });
    const chip = (id: string, label: string, n: number) => {
      const b = el(
        'button',
        { class: `r-chip${S.savedFilter === id ? ' r-on' : ''}`, type: 'button', 'aria-pressed': String(S.savedFilter === id) },
        `${label} · ${n}`,
      );
      b.addEventListener('click', () => {
        S.savedFilter = id;
        paint();
      });
      chips.append(b);
    };
    chip('all', 'All', all.length);
    chip('unsorted', 'Unsorted', all.filter((r) => !r.folder || !folders.some((f) => f.id === r.folder)).length);
    for (const f of folders) chip(f.id, f.name, all.filter((r) => r.folder === f.id).length);
    const grid = masonry(el('div', { class: 'r-grid' }));
    const cands = list.map((r): Cand => ({
      key: r.key,
      src: r.src,
      title: r.title,
      thumb: r.thumb,
      full: r.full,
      page: r.page,
      artist: r.artist,
      tags: [],
      aspect: r.aspect,
      pos: 0,
    }));
    list.forEach((r, i) => {
      const img = el('img', { src: r.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      const e = el('div', {
        class: 'r-cell r-in',
        style: `--c:${TONES[i % TONES.length]};aspect-ratio:${Math.min(Math.max(r.aspect ?? 1, 0.6), 1.6)}`,
        'data-key': r.key,
      });
      img.addEventListener('load', () => e.classList.add('r-loaded'));
      const open = el('button', { class: 'r-open', type: 'button', 'aria-label': `${r.title}. Open` }, img);
      open.addEventListener('click', () => openViewer(i, () => cands));
      img.addEventListener('error', () => {
        if (!img.dataset.retried && !r.thumb.startsWith('https://wsrv.nl/')) {
          img.dataset.retried = '1';
          img.src = showUrl(r.thumb);
          return;
        }
        // unlike a search result it isn't hidden: it's the user's pick, so say what it was
        e.classList.add('r-loaded', 'r-broken');
        open.append(el('span', { class: 'r-unavail' }, ic('image'), 'Image unavailable'));
        open.setAttribute('aria-label', `${r.title}, image unavailable. Open`);
      });
      const move = el(
        'button',
        {
          type: 'button',
          class: 'r-move',
          'aria-label': `Move ${r.title} to a folder`,
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'data-tip': 'Move to folder',
        },
        ic('folder'),
      );
      move.addEventListener('click', () => {
        const fs = host.folders();
        openFolderMenu(move, {
          folders: fs,
          current: fs.some((f) => f.id === r.folder) ? r.folder : undefined, // a deleted folder's items are Unsorted
          onPick: (id) => {
            const cur = saved[r.key];
            if (cur && putSaved(r.key, { ...cur, folder: id })) focusSaved(r.key, i, '.r-move');
          },
          onCreate: (name) => host.addFolder(name),
        });
      });
      const del = el(
        'button',
        { type: 'button', 'aria-label': `Remove ${r.title}`, 'data-tip': 'Remove', class: 'r-tip-end' },
        ic('trash'),
      );
      del.addEventListener('click', () => {
        if (removeSaved(r.key, () => focusSaved(r.key, i))) focusSaved(r.key, i);
      });
      e.append(
        open,
        el('div', { class: 'r-votes' }, move, del),
        el('div', { class: 'r-cap' }, el('span', {}, r.title), el('span', {}, SOURCE_BY_ID[r.src]?.label ?? '')),
      );
      if (img.complete) e.classList.add('r-loaded');
      grid.append(e);
    });
    body.append(
      el(
        'section',
        { class: 'r-saved', 'aria-label': 'Saved references' },
        back,
        el('h2', {}, `Saved references · ${all.length}`),
        chips,
        list.length
          ? grid
          : el('p', { class: 'r-meta' }, all.length ? 'Nothing in this folder yet.' : 'Nothing saved yet. Open a result and press Save.'),
      ),
    );
  }

  // ---------------------------------------------------------------- page API
  onVisionState(scheduleStatus);
  paint();
  return {
    show() {
      page.hidden = false;
      // back on the start screen: a fresh set of ideas each visit
      if (S.visits++ && !S.ran && !S.bmp && !S.like && S.view !== 'saved') {
        S.tiles = null;
        resetFeed();
        paint();
      } else if (!S.search && (S.ran || S.bmp || S.like)) run(null, { fresh: true }); // Back/Forward restored it while hidden
      if (S.view === 'saved') paint(); // folders may have been renamed or deleted on Briefs
      S.search?.resume();
      void warmVision().catch(() => undefined); // background download of the ranking model
      if (!S.ran && !S.bmp && !S.like && !COARSE) setTimeout(() => input.focus(), 0);
    },
    hide() {
      page.hidden = true;
      closePop(false);
      if (S.viewerOpen) requestClose(); // also pops the viewer's history entry
      S.search?.pause();
    },
    toggleSaved() {
      showSaved(S.view !== 'saved');
    },
    savedCount: () => Object.keys(saved).length,
  };
}

