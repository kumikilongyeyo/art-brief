/** The reference board on a brief card: one big picture of the subject and a few for its parts (look,
 *  wearing, setting, light…), found by brief-refs.ts. Each part fills in as its search finishes; a picture
 *  can be swapped for the next best, kept through Refresh and rerolls, or removed. The pictures are kept
 *  with the brief (so a saved brief opens with its board) and export to a PureRef board. */
import type { Brief, DataSet, RefBoard, RefPick } from '../engine/types';
import { h, icon } from '../ui/dom';
import { toastHost } from '../ui/toast';
import { choose, partsFor, resolve, searchPart, type Part } from './brief-refs';
import { imageAlts } from './net';
import { SOURCE_BY_ID } from './sources';
import type { SourceId } from './types';
import { loadVocab, type Vocab } from './vocab';

export interface BoardHost {
  data: DataSet;
  /** The board changed: keep its pictures with the brief (and in Saved, when it's saved). */
  save: (briefId: string, refs: RefBoard) => void;
  toast: (msg: string) => void;
  /** Download the board as a PureRef file. */
  exportPur: (brief: Brief, picks: RefPick[]) => Promise<void>;
}

/** Boards by card place (a batch's base and the variation's index): a reroll makes a new brief with a new
 *  id, and its board must carry on, keeping the parts whose words didn't change. */
const boards = new Map<string, Board>();
const KEEP = 12;
const MIN = 5; // a board shows at least this many pictures when the searches found that many

export function boardFor(brief: Brief, host: BoardHost): HTMLElement {
  const key = `${brief.base}:${brief.index}`;
  let b = boards.get(key);
  if (!b) {
    b = new Board(host);
    boards.set(key, b);
    // a few recent batches stay (Back to an earlier result keeps its board); older ones stop and go
    for (const [k, old] of boards) {
      if (boards.size <= KEEP) break;
      old.stop();
      boards.delete(k);
    }
  }
  b.show(brief);
  return b.el;
}

const partKey = (p: Part) => p.tries.join('|');
/** The tile's picture: ArtStation covers come in 400² and 800²; the big tile takes the larger. */
const tileSrc = (p: RefPick, big: boolean) => (big && p.src === 'artstation' ? p.thumb.replace('/smaller_square/', '/small_square/') : p.thumb);
const sourceName = (src: string) => SOURCE_BY_ID[src as SourceId]?.label ?? src;

/** An <img> that tries its fallbacks (wsrv.nl, the relay) before giving up, then calls `broken`. */
function picture(src: string, alts: string[], broken: () => void, eager = false): HTMLImageElement {
  // ArtStation's CDN answers with or without CORS but its cache doesn't vary by it: a plain <img> would
  // leave a copy the ranking (and PureRef export) can't read, so its pictures load in CORS mode too
  const cors = /^https:\/\/cdn[a-z]\.artstation\.com\//.test(src) ? 'anonymous' : undefined;
  const img = h('img', { src, alt: '', loading: eager ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', crossorigin: cors });
  const queue = [...alts];
  img.addEventListener('error', () => {
    const next = queue.shift();
    if (next) img.src = next;
    else broken();
  });
  return img;
}

class Board {
  el = h('section', { class: 'rb', 'aria-label': 'References' });
  private brief!: Brief;
  private v?: Vocab;
  private parts: Part[] = [];
  private picks: RefPick[] = [];
  private spares = new Map<string, RefPick[]>();
  private asked: Record<string, string> = {};
  private running = new Map<string, { key: string; ctl: AbortController }>();
  /** Parts waiting for their search (the rest wait for the subject's): they show as places already. */
  private queued = new Set<string>();
  private vecs = new Map<string, Float32Array>();
  /** Pictures the user removed or refreshed away: never offered again on this board. */
  private gone = new Set<string>();
  private failed = new Set<string>();
  private retried = new Set<string>();
  private hitCount = new Map<string, number>();
  private viewer?: HTMLDialogElement;

  private seen = false;
  private io?: IntersectionObserver;
  private poll = 0;

  constructor(private host: BoardHost) {}

  /** Searches start once the board is on screen: a batch's other variations (hidden tabs) wait their turn. */
  private whenSeen(run: () => void) {
    if (this.seen) return run();
    const go = () => {
      if (this.seen) return;
      this.seen = true;
      this.io?.disconnect();
      clearInterval(this.poll);
      run();
    };
    this.io ??= new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && go());
    this.io.observe(this.el);
    // the observer only reports while the page is drawn: laid out and not in a hidden tab also counts
    clearInterval(this.poll);
    this.poll = window.setInterval(() => {
      if (this.el.isConnected && this.el.getClientRects().length > 0) go();
    }, 1000);
  }

  stop() {
    for (const r of this.running.values()) r.ctl.abort();
    this.running.clear();
    this.queued.clear();
    this.io?.disconnect();
    clearInterval(this.poll);
  }

  show(brief: Brief) {
    this.brief = brief;
    // a brief that comes with its board (saved, or back from history) shows it as it was
    if (!this.picks.length && brief.refs?.picks.length) {
      this.picks = brief.refs.picks.map((p) => ({ ...p }));
      this.asked = { ...brief.refs.asked };
    }
    this.render();
    this.whenSeen(() => void this.sync());
  }

  /** Search the parts that have no pictures yet, or whose words changed (a reroll). */
  private async sync() {
    const brief = this.brief;
    this.v ??= await loadVocab().catch(() => undefined);
    if (brief !== this.brief) return; // shown again meanwhile: that call carries on
    this.parts = partsFor(this.host.data, brief, this.v);
    const ids = new Set(this.parts.map((p) => p.id));
    const stale = this.parts.filter((p) => this.asked[p.id] !== partKey(p) && this.running.get(p.id)?.key !== partKey(p) && !this.failed.has(partKey(p)));
    const before = this.picks.length;
    // a part that's gone, or asked with other words now, loses its pictures (kept ones stay)
    this.picks = this.picks.filter((k) => k.locked || (ids.has(k.part) && !stale.some((p) => p.id === k.part)));
    for (const p of stale) this.spares.delete(p.id);
    if (this.picks.length !== before) this.save();
    this.render();
    if (!stale.length) return;
    // the subject first (it's the big picture, and the rest are ranked toward it), then the rest together
    const subject = stale.find((p) => p.id === 'subject');
    const rest = stale.filter((p) => p !== subject);
    rest.forEach((p) => this.queued.add(p.id));
    if (subject) await this.runPart(subject);
    await Promise.all(rest.map((p) => this.runPart(p)));
  }

  private async runPart(p: Part, fresh = false) {
    const key = partKey(p);
    this.queued.delete(p.id);
    if (!fresh && this.running.get(p.id)?.key === key) return;
    this.running.get(p.id)?.ctl.abort();
    const ctl = new AbortController();
    this.running.set(p.id, { key, ctl });
    this.render();
    try {
      const q = await resolve(p, ctl.signal);
      const like =
        p.id === 'subject' ? [] : this.picks.filter((k) => k.part === 'subject').flatMap((k) => this.vecs.get(k.key) ?? []);
      const hits = (await searchPart(q, ctl.signal, like)).filter((x) => !this.gone.has(x.c.key));
      if (ctl.signal.aborted) return;
      const kept = this.picks.filter((k) => k.part === p.id && k.locked);
      const others = this.picks.filter((k) => k.part !== p.id).concat(kept);
      this.hitCount.set(p.id, hits.length);
      const r = choose(q, hits, others, this.vecs, Math.max(0, p.n - kept.length));
      this.picks = [...this.picks.filter((k) => k.part !== p.id), ...kept, ...r.picks];
      this.spares.set(p.id, r.spares);
      this.asked[p.id] = key;
      this.failed.delete(key);
      this.save();
    } catch (e) {
      if (ctl.signal.aborted) return;
      if (import.meta.env.DEV) console.warn('[board]', p.id, e);
      // once more a moment later (a dropped connection, a busy device); a second failure waits for Refresh
      if (!this.retried.has(key)) {
        this.retried.add(key);
        this.queued.add(p.id);
        setTimeout(() => void this.runPart(p, true), 2000);
      } else this.failed.add(key);
    } finally {
      if (this.running.get(p.id)?.ctl === ctl) this.running.delete(p.id);
      if (!this.running.size && !this.queued.size) this.topUp();
      this.render();
    }
  }

  /** A board of fewer than MIN pictures (some parts found nothing) takes the best swaps, subject's first. */
  private topUp() {
    const short = MIN - this.picks.length;
    if (short <= 0) return;
    const extra: RefPick[] = [];
    for (const p of this.parts)
      for (const k of this.spares.get(p.id) ?? []) if (extra.length < short && !this.gone.has(k.key) && !this.picks.some((x) => x.key === k.key)) extra.push(k);
    if (!extra.length) return;
    for (const k of extra) this.spares.set(k.part, (this.spares.get(k.part) ?? []).filter((x) => x !== k));
    this.picks = [...this.picks, ...extra];
    this.save();
  }

  private save() {
    // in board order, so a reopened board looks the same before its parts are worked out again
    this.host.save(this.brief.id, { picks: this.ordered().map((p) => ({ ...p })), asked: { ...this.asked } });
  }

  // ------------------------------------------------------------ actions

  /** The next best picture of the same part in this one's place. */
  private swap(pick: RefPick) {
    const next = this.spares.get(pick.part)?.shift();
    if (!next) {
      this.host.toast(`No more for ${pick.label} — Refresh searches again`);
      return;
    }
    this.gone.add(pick.key);
    this.picks = this.picks.map((k) => (k === pick ? next : k));
    this.save();
    this.render();
  }
  private lock(pick: RefPick) {
    pick.locked = !pick.locked;
    this.save();
    this.render();
  }
  private remove(pick: RefPick) {
    this.gone.add(pick.key);
    this.picks = this.picks.filter((k) => k !== pick);
    this.save();
    this.render();
  }
  /** New pictures for everything not kept: the swaps first, and a new search where they've run out. */
  private refresh() {
    const again: Part[] = [];
    for (const p of this.parts) {
      const mine = this.picks.filter((k) => k.part === p.id);
      const loose = mine.filter((k) => !k.locked);
      if (!loose.length && mine.length >= p.n) continue;
      loose.forEach((k) => this.gone.add(k.key));
      const spares = (this.spares.get(p.id) ?? []).filter((k) => !this.gone.has(k.key));
      const want = p.n - (mine.length - loose.length);
      if (spares.length >= want) {
        this.picks = [...this.picks.filter((k) => !loose.includes(k)), ...spares.slice(0, want)];
        this.spares.set(p.id, spares.slice(want));
      } else again.push(p);
    }
    this.failed.clear();
    this.save();
    this.render();
    for (const p of again) void this.runPart(p, true);
  }

  // ------------------------------------------------------------ view

  private ordered(): RefPick[] {
    const at = new Map(this.parts.map((p, i) => [p.id, i]));
    return [...this.picks].sort((a, b) => (at.get(a.part) ?? 99) - (at.get(b.part) ?? 99));
  }

  private render() {
    const picks = this.ordered();
    // busy until every part has been asked (before that the board shows its outline)
    const busy = this.running.size > 0 || this.queued.size > 0 || (!this.parts.length && !picks.length);
    // tiles in part order, and where a part is still searching, shimmering places for its pictures
    const cells: Array<RefPick | Part> = [];
    for (const p of this.parts.length ? this.parts : [...new Set(picks.map((k) => k.part))].map((id) => ({ id }) as Part)) {
      const mine = picks.filter((k) => k.part === p.id);
      cells.push(...mine);
      if (this.running.has(p.id) || this.queued.has(p.id)) for (let i = mine.length; i < p.n; i++) cells.push(p);
    }
    for (const k of picks) if (!cells.includes(k)) cells.push(k); // kept pictures of a part that's gone
    // not asked yet (the vocabulary is loading, or the board isn't on screen yet): the board's outline
    if (!this.parts.length && !picks.length) for (let i = 0; i < 8; i++) cells.push({ id: '', n: 0 } as unknown as Part);
    const n = cells.length;
    const board = h('div', { class: 'rb-grid', 'data-count': String(n) });
    // option B: the subject big (two rows), the second picture wide, then rows of three (two on a phone);
    // the last row's pictures widen to fill it, so the board has no holes whatever it found
    const lastD = n > 4 ? (n - 4) % 3 : 0,
      lastM = n > 3 ? (n - 3) % 2 : 0;
    cells.forEach((c, i) => {
      const t = 'key' in c ? this.tile(c, i === 0) : h('div', { class: 'rb-tile rb-wait', 'aria-hidden': 'true' });
      if (i === n - 1 && lastD) t.classList.add(lastD === 1 ? 'rb-d3' : 'rb-d2');
      if (i === n - 1 && lastM) t.classList.add('rb-m2');
      if (n === 3 && i === 2) t.classList.add('rb-d2');
      if (n === 2 && i === 1) t.classList.add('rb-tall');
      board.append(t);
    });

    const head = h(
      'div',
      { class: 'rb-head' },
      h('h3', {}, 'References', picks.length ? h('span', { class: 'rb-count' }, ` · ${picks.length}`) : null),
      h(
        'div',
        { class: 'rb-acts' },
        h(
          'button',
          { class: 'btn rb-btn', type: 'button', disabled: busy || !this.parts.length, title: 'New pictures for everything not kept', onclick: () => this.refresh() },
          icon('reroll'),
          'Refresh',
        ),
        h(
          'button',
          {
            class: 'btn rb-btn',
            type: 'button',
            disabled: !picks.length,
            title: 'Download as a PureRef board',
            onclick: (e: Event) => {
              const b = e.currentTarget as HTMLButtonElement;
              b.disabled = true;
              void this.host.exportPur(this.brief, picks).finally(() => (b.disabled = false));
            },
          },
          icon('download'),
          'PureRef',
        ),
      ),
    );
    const status =
      busy && !picks.length
        ? h('p', { class: 'rb-note', role: 'status' }, 'Finding references…')
        : !busy && !picks.length && this.parts.length
          ? h('p', { class: 'rb-note', role: 'status' }, 'No references found. Refresh to try again.')
          : null;
    this.el.replaceChildren(head, ...(n ? [board] : []), ...(status ? [status] : []));
    this.el.setAttribute('aria-busy', String(busy));
    // for tests and bug reports: how each part went (asked, found, failed)
    this.el.dataset.parts = this.parts.map((p) => `${p.id}:${this.failed.has(partKey(p)) ? 'failed' : this.asked[p.id] ? picks.filter((k) => k.part === p.id).length + '/' + (this.spares.get(p.id)?.length ?? 0) + '/' + (this.hitCount.get(p.id) ?? '?') : '…'}`).join(' ');
  }

  private tile(p: RefPick, big: boolean): HTMLElement {
    const t = h('div', {
      class: `rb-tile${p.locked ? ' locked' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${p.label}: ${p.title}. Open`,
      'data-part': p.part,
      title: `${p.label} · ${p.q}`,
    });
    const src = tileSrc(p, big);
    t.append(
      picture(src, [p.thumb, ...imageAlts(p.thumb)].filter((u) => u !== src), () => this.broken(p), big),
      h('span', { class: 'rb-lab' }, p.label),
      h(
        'span',
        { class: 'rb-tools' },
        this.tool('Swap for another', 'reroll', () => this.swap(p)),
        this.tool(p.locked ? 'Unlock' : 'Keep this one', p.locked ? 'lock' : 'unlock', () => this.lock(p), p.locked),
        this.tool('Remove', 'close', () => this.remove(p)),
      ),
    );
    const open = () => this.open(p);
    t.addEventListener('click', open);
    t.addEventListener('keydown', (e) => {
      if (e.target === t && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        open();
      }
    });
    return t;
  }

  private tool(label: string, name: string, run: () => void, pressed?: boolean) {
    return h(
      'button',
      {
        class: 'rb-tool',
        type: 'button',
        'aria-label': label,
        title: label,
        'aria-pressed': pressed === undefined ? undefined : String(pressed),
        onclick: (e: Event) => {
          e.stopPropagation();
          run();
        },
      },
      icon(name),
    );
  }

  /** A picture that won't load anywhere: the next best takes its place. */
  private broken(p: RefPick) {
    if (!this.picks.includes(p)) return;
    const next = this.spares.get(p.part)?.shift();
    this.gone.add(p.key);
    this.picks = next ? this.picks.map((k) => (k === p ? next : k)) : this.picks.filter((k) => k !== p);
    this.save();
    this.render();
  }

  /** The picture large, with where it's from and the same tools. */
  private open(p: RefPick) {
    const list = this.ordered();
    let i = Math.max(0, list.indexOf(p));
    const d = (this.viewer ??= h('dialog', { class: 'rb-view', 'aria-label': 'Reference' }));
    const show = () => {
      const k = list[i];
      if (!k) return d.close();
      const alts = [tileSrc(k, true), k.thumb, ...imageAlts(k.full, 1600)].filter((u, j, a) => u !== k.full && a.indexOf(u) === j);
      const nav = (step: number) => () => {
        i = (i + step + list.length) % list.length;
        show();
      };
      d.replaceChildren(
        h(
          'div',
          { class: 'rb-view-pic' },
          picture(k.full, alts, () => undefined, true),
          list.length > 1 ? h('button', { class: 'rb-nav prev', type: 'button', 'aria-label': 'Previous', onclick: nav(-1) }, icon('chevron')) : null,
          list.length > 1 ? h('button', { class: 'rb-nav next', type: 'button', 'aria-label': 'Next', onclick: nav(1) }, icon('chevron')) : null,
        ),
        h(
          'div',
          { class: 'rb-view-side' },
          h('button', { class: 'icon-btn rb-x', type: 'button', 'aria-label': 'Close', onclick: () => d.close() }, icon('close')),
          h('p', { class: 'rb-view-part' }, `${k.label} · ${k.q}`),
          h('h3', {}, k.title || 'Untitled'),
          h('p', { class: 'rb-view-by' }, [k.artist, sourceName(k.src)].filter(Boolean).join(' · ')),
          h('a', { class: 'btn rb-view-open', href: k.page, target: '_blank', rel: 'noopener noreferrer' }, `Open on ${sourceName(k.src)}`),
          h(
            'div',
            { class: 'rb-view-tools' },
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => {
                  this.lock(k);
                  show();
                },
              },
              icon(k.locked ? 'lock' : 'unlock'),
              k.locked ? 'Kept' : 'Keep',
            ),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => {
                  this.remove(k);
                  list.splice(i, 1);
                  if (i >= list.length) i = 0;
                  show();
                },
              },
              icon('trash'),
              'Remove',
            ),
          ),
        ),
      );
    };
    show();
    d.onkeydown = (e) => {
      if (list.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        i = (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
        show();
      }
    };
    d.onclick = (e) => e.target === d && d.close(); // the backdrop
    d.onclose = () => toastHost(null);
    if (!d.isConnected) document.body.append(d);
    if (!d.open) d.showModal();
    toastHost(d);
  }
}
