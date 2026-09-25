/** One reference search: plans the query, asks every relevant source at once, ranks what comes back
 *  by how it looks (MobileCLIP) plus tags, source trust and pose, and hands out batches of 10.
 *
 *  Contract of next(): it resolves with at least one result, or with [] only when every source is
 *  finished and nothing rankable is left (then `status().exhausted` is true). It never busy-loops. */
import { rankUrl } from './net';
import { describePose, fromMoveNet, poseMatch, type Skeleton } from './pose';
import { SOURCE_BY_ID, SOURCES } from './sources';
import type { Cand, EffMode, Mode, Plan, SearchCtx, Source, SourceId } from './types';
import { embedBitmap, embedUrl, visionFailed, visionState, warmVision } from './vision';
import { DIM, gateScorer, imageWords, loadVocab, makePlan, normalize, queryVector } from './vocab';

export interface Hit {
  c: Cand;
  prelim: number; // before the model has seen it: tags, source trust, the source's own order
  vec?: Float32Array;
  sim?: number; // match by look
  gate?: number; // > 0 = reads as adult
  pose?: number; // 0…1 match to the query pose (pose searches)
  figure?: boolean; // MoveNet found a person (Pose-mode searches)
  state: 'cold' | 'queued' | 'ranked' | 'dropped';
  why?: 'floor' | 'adult' | 'dupe' | 'broken' | 'unliked';
  shownAt?: number;
}

export interface SearchInput {
  text: string;
  mode: Mode;
  adult: boolean;
  /** The user's image (already cropped), or a result's own vector for "More like this". */
  image?: ImageBitmap | Float32Array;
  mirror?: boolean;
  /** Words for the source queries when there's no text (More like this passes the result's title). */
  hint?: string;
  exclude?: string; // a result key never to show (the image More like this started from)
  /** 👍/👎 carried over from the previous search with the same words and image. */
  prior?: { up: Float32Array[]; down: Float32Array[] };
  /** Already-ranked results to start from (More like this starts with the viewer's Similar strip). */
  seed?: Hit[];
  /** Sources the user switched off in Search settings. */
  off?: SourceId[];
  /** The pose to match (read from a stick figure, or MoveNet on the user's photo). */
  pose?: Skeleton;
  /** The image is a line drawing: search by its pose, not by how the drawing looks. */
  sketch?: boolean;
}

export interface Status {
  shown: number;
  ranked: number;
  found: number;
  sourcesAsked: number;
  sourcesDone: number;
  exhausted: boolean;
  /** a rare pose: nothing came close, so the nearest figures are shown instead */
  nearest: boolean;
  plan?: Plan;
}

type SrcState = { s: Source; page: number; more: boolean; busy: boolean; fails: number };

const BATCH = 10;
const PER_SOURCE = 4; // at most this many from one web source in a batch of 10
const PER_LOCAL = 2; // …and from one catalog (they answer instantly and would otherwise fill the screen)
const LOCAL_TOTAL = 3; // all catalogs together, per batch of 10
const WEB_SOURCES = 3; // the first batch waits for this many web sources to have ranked results
const FIRST_WAIT = 2000; // ms the first batch waits for ranking
const SKETCH_WAIT = 3200;
const NEXT_WAIT = 1200;
const LOW_WATER = 40; // unseen candidates below this → ask sources for another page
const AHEAD = 36; // keep this many ranked-or-ranking candidates ahead of the screen
/** Stick-figure searches keep figures whose limbs point roughly the same way (0…1): at least POSE_FLOOR,
 *  and not far below the closest pose found, so a rare pose still gets its nearest matches. */
export const POSE_MIN = 0.6;
const POSE_FLOOR = 0.4;
/** …and if nothing reaches POSE_FLOOR within NEAREST_AFTER ms, the nearest figures down to POSE_DROP
 *  are shown (and said to be the nearest) rather than leaving the screen empty. */
const POSE_DROP = 0.25;
/** A stick-figure result that isn't a readable figure must look this much like the pose's words. */
const SKETCH_LOOK = 0.2;
/** Titles and tags that say what the picture is, when the look check misses it (old photos, sketches). */
const ADULT_WORDS =
  /\b(nude|nudes|naked|nudity|topless|bottomless|erotic|erotica|nsfw|hentai|ecchi|lingerie|panties|underwear|thong|breasts?|nipples?|boobs?|buttocks|porn\w*|sexy|seductive|sensual|boudoir|fetish|bdsm|stripper)\b/i;
const NEAREST_AFTER = 6500;
/** How a stick figure's pose is asked for on sites that search titles and tags. */
const SKETCH_QUERY: Record<string, string> = {
  running: 'man running',
  lunging: 'lunge pose',
  'fighting stance': 'fighting stance',
  'arms raised': 'arms raised',
  jumping: 'person jumping',
  kneeling: 'kneeling man',
  sitting: 'person sitting',
  crouching: 'crouching man',
  'lying down': 'person lying down',
  'dynamic pose': 'dynamic pose',
  standing: 'standing man full body',
};
/** > this reads as adult (gate prompts in public/refs/gate.bin). */
const GATE_T = 0.02;

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let d = 0; d < DIM; d++) s += a[d] * b[d];
  return s;
};

export class Search {
  plan?: Plan;
  private q: Float32Array | null = null; // everything combined: what results are scored against
  private qImg: Float32Array | null = null;
  private qMirror: Float32Array | null = null;
  private qText: Float32Array | null = null;
  private hits = new Map<string, Hit>();
  private shown: Hit[] = [];
  private srcs: SrcState[] = [];
  private ctl = new AbortController();
  private ctx: SearchCtx = { q: null, memo: new Map() };
  private t0 = performance.now();
  private inflight = 0;
  private best = 0;
  private bestPose = 0;
  private nearestOnly = false;
  private gate?: (e: Float32Array) => number;
  private votes = new Map<string, 'up' | 'down'>();
  private srcPenalty = new Map<SourceId, number>();
  private perSrcQueued = new Map<SourceId, number>();
  private waiters: Array<() => void> = [];
  private paused = false;
  private started: Promise<void>;
  onChange: () => void = () => {};

  constructor(private input: SearchInput) {
    this.started = this.start();
    this.started.catch(() => this.notify());
  }

  abort() {
    this.ctl.abort();
    this.notify();
  }
  /** Stop asking sources and ranking while the page is hidden; resume() carries on. */
  pause() {
    this.paused = true;
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.topUp();
    this.notify();
  }

  status(): Status {
    let ranked = 0;
    for (const h of this.hits.values()) if (h.state === 'ranked') ranked++;
    return {
      shown: this.shown.length,
      ranked,
      found: this.hits.size,
      sourcesAsked: this.srcs.length,
      sourcesDone: this.srcs.filter((s) => !s.busy).length,
      exhausted: this.exhausted(),
      nearest: this.nearestOnly,
      plan: this.plan,
    };
  }

  /** Every candidate and what happened to it (dev self-tests read this). */
  debug() {
    return [...this.hits.values()].map((h) => ({ src: h.c.src, title: h.c.title, thumb: h.c.thumb, state: h.state, why: h.why, sim: h.sim, pose: h.pose, gate: h.gate, figure: h.figure, shown: h.shownAt !== undefined, passes: this.passes(h) }));
  }

  private exhausted(): boolean {
    if (!this.srcs.length) return false;
    if (this.srcs.some((s) => s.busy || (s.more && s.fails < 3))) return false;
    if (this.inflight > 0) return false;
    for (const h of this.hits.values()) if (h.shownAt === undefined && (h.state === 'cold' || h.state === 'queued' || (h.state === 'ranked' && this.passes(h)))) return false;
    return true;
  }

  private notify() {
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
    this.onChange();
  }
  private wake(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        r();
      });
    });
  }

  // ---------------------------------------------------------------- setup
  private async start() {
    void warmVision().catch(() => undefined);
    const v = await loadVocab();
    const { text, mode, adult, image, mirror, hint } = this.input;
    let words: string[] = [];
    let eff: Mode = mode;
    if (this.input.sketch && this.input.pose) {
      // a stick figure looks like nothing else: its pose becomes the words, and ranking goes by pose
      // "dynamic pose" says nothing about which pose, and pulls in every dramatic splash art: leave it out
      const d = describePose(this.input.pose);
      words = d.length > 1 ? d.filter((w) => w !== 'dynamic pose') : d;
      eff = 'pose';
    } else if (image) {
      const vecs = image instanceof Float32Array ? [image] : (await embedBitmap(image, !!mirror, 1e9, false, this.ctl.signal)).vecs;
      this.qImg = vecs[0];
      this.qMirror = vecs[1] ?? null;
      // the picture is searched by how it looks; words read from it only phrase the source queries,
      // and never pick the mode (a castle painting isn't a "creature" search because it has a dragon in it)
      if (!text.trim()) words = await imageWords(v, vecs[0], 4);
      if (mode === 'auto') eff = this.input.pose ? 'pose' : 'concept';
    }
    // a sketch asks the sources in a few plain words ("man running"): long queries find nothing on most
    // sites; the rest of the description ("full body") still reaches the tag-based ones through the keys
    const said = this.input.sketch && !text.trim() && !hint ? SKETCH_QUERY[words[0]] ?? words[0] : text || hint || words.join(' ');
    this.plan = makePlan(v, said, eff, adult, words);
    if (!this.plan.text) this.plan.text = words.slice(0, 2).join(' ');
    // only the user's own words shape the look score (hint and image words are for the sources)
    this.qText = text.trim() || this.input.sketch ? await queryVector(v, this.plan) : null;
    this.rebuildQuery();
    this.gate = await gateScorer(v).catch(() => undefined);
    this.ctx.pose = this.input.pose;
    for (const s of this.input.seed ?? []) {
      if (!s.vec || s.c.key === this.input.exclude || this.hits.has(s.c.key)) continue;
      const h: Hit = { c: s.c, prelim: s.prelim, vec: s.vec, gate: s.gate, state: 'ranked', figure: s.figure, pose: s.pose };
      this.score(h);
      this.hits.set(s.c.key, h);
    }
    const m = this.plan.mode;
    const off = new Set(this.input.off ?? []);
    this.srcs = SOURCES.filter((s) => s.trust[m] >= 0.3 && !off.has(s.id))
      .sort((a, b) => b.trust[m] - a.trust[m])
      .map((s) => ({ s, page: 0, more: true, busy: false, fails: 0 }));
    for (const st of this.srcs) void this.fetchPage(st);
    this.notify();
  }

  /** Text and image combine; 👍/👎 pull the query toward / away from what you picked. */
  private rebuildQuery() {
    const q = new Float32Array(DIM);
    const add = (vec: Float32Array | null, w: number) => {
      if (vec) for (let d = 0; d < DIM; d++) q[d] += vec[d] * w;
    };
    add(this.qImg, 1);
    add(this.qText, this.qImg ? 0.55 : 1);
    const { up, down } = this.priorOut();
    for (const vec of up) add(vec, 0.4 / up.length);
    for (const vec of down) add(vec, -0.25 / down.length);
    let n = 0;
    for (const x of q) n += x * x;
    this.q = n > 0 ? normalize(q) : null;
    this.ctx.q = this.q;
    this.best = 0;
    for (const h of this.hits.values()) if (h.vec && (h.state === 'ranked' || h.why === 'unliked')) this.score(h);
  }

  private simOf(e: Float32Array): number {
    if (!this.q) return 0;
    let s = dot(this.q, e);
    if (this.qMirror && this.qImg) s = Math.max(s, s - dot(this.qImg, e) + dot(this.qMirror, e)); // same thing facing the other way
    return s;
  }

  /** Scores a ranked hit (and drops it when it can't be a match). */
  private score(h: Hit) {
    if (!h.vec) return;
    h.sim = this.simOf(h.vec);
    const down = this.priorOut().down;
    if (down.some((d) => dot(d, h.vec!) > 0.8)) {
      h.state = 'dropped';
      h.why = 'unliked';
      return;
    }
    if (this.input.image instanceof Float32Array && this.qImg && dot(this.qImg, h.vec) > 0.95) {
      h.state = 'dropped'; // More like this: the same picture again (a repost or reprint)
      h.why = 'dupe';
      return;
    }
    if (!this.plan?.adult && !SOURCE_BY_ID[h.c.src]?.sfw && ((h.gate ?? -1) > GATE_T || ADULT_WORDS.test(`${h.c.title} ${h.c.tags.join(' ')}`))) {
      h.state = 'dropped';
      h.why = 'adult';
      return;
    }
    h.state = 'ranked';
    this.best = Math.max(this.best, h.sim);
    if (h.pose !== undefined) this.bestPose = Math.max(this.bestPose, h.pose);
  }
  private total(h: Hit): number {
    if (h.sim === undefined) return -1 + h.prelim;
    const pen = this.srcPenalty.get(h.c.src) ?? 0;
    if (this.input.sketch) return 0.7 * (h.pose ?? 0) + 0.3 * Math.max(0, 1 - (this.best - h.sim) / 0.08) - pen; // pose matches first, then look-alikes
    const noFigure = this.wantsFigures() && h.figure === false ? 0.16 : 0; // a lone sword isn't a pose reference
    const pose = this.input.pose ? 0.3 * (h.pose ?? 0) : 0;
    return h.sim + 0.03 * h.prelim + pose - noFigure - pen;
  }
  /** Relevance floor: an absolute minimum, and not far below the best match so far. */
  private passes(h: Hit): boolean {
    if (h.state !== 'ranked' || h.sim === undefined) return false;
    if (this.input.sketch) {
      const poseT = this.nearestOnly ? POSE_DROP : Math.min(POSE_MIN, Math.max(POSE_FLOOR, this.bestPose - 0.15));
      // the joint finder often can't read stylised art (a cartoon runner scores 0), but the picture still
      // looks exactly like the words for the pose: those count too — except catalog art, whose figures
      // were read when the index was built, so it must match by pose
      if ((h.pose ?? 0) >= poseT) return true;
      return !SOURCE_BY_ID[h.c.src]?.local && h.sim >= Math.max(SKETCH_LOOK, this.best - 0.04);
    }
    if (!this.q) return true;
    if (this.wantsFigures() && h.figure === false && this.input.pose) return false;
    const f = this.qImg ? Math.max(0.3, this.best - 0.3) : Math.max(0.15, this.best - 0.13);
    // catalogs always return their nearest cards, even when none fit ("castle" in a card game with no
    // castles): they must come close to the best match found anywhere
    if (SOURCE_BY_ID[h.c.src]?.local) return h.sim >= Math.max(f, this.best - (this.qImg ? 0.12 : 0.07), this.qImg ? 0.45 : 0.19);
    return h.sim >= f;
  }
  private wantsFigures() {
    return !!this.input.pose || this.plan?.mode === 'pose';
  }

  // ---------------------------------------------------------------- sources
  private async fetchPage(st: SrcState) {
    if (st.busy || !st.more || st.fails >= 3 || this.ctl.signal.aborted || this.paused || !this.plan) return;
    st.busy = true;
    try {
      const page = await st.s.search(this.plan, st.page, this.ctl.signal, this.ctx);
      st.page++;
      st.more = page.more;
      st.fails = 0;
      for (const c of page.items) this.add(c);
    } catch {
      if (!this.ctl.signal.aborted) {
        st.fails++;
        if (st.fails >= 3) st.more = false;
      }
    } finally {
      st.busy = false;
      this.topUp();
      this.notify();
    }
  }

  private add(c: Cand) {
    if (!c.thumb || this.hits.has(c.key) || c.key === this.input.exclude) return;
    const m = this.plan!.mode;
    const tw = new Set([...c.tags, ...c.title.toLowerCase().split(/[^a-z0-9]+/)]);
    const ws = this.plan!.words;
    const tm = ws.length ? ws.filter((w) => tw.has(w)).length / ws.length : 0;
    const trust = SOURCE_BY_ID[c.src]?.trust[m] ?? 0.3;
    const h: Hit = { c, prelim: 0.5 * tm + 0.35 * trust + 0.15 / (1 + c.pos / 8), state: 'cold' };
    this.hits.set(c.key, h);
    if (c.adult && !this.plan!.adult) {
      h.state = 'dropped';
      h.why = 'adult';
    } else if (c.vec) {
      // pre-analysed catalog: already has its vector (and pose score)
      h.vec = c.vec;
      h.pose = c.poseScore;
      h.figure = c.poseScore !== undefined ? true : c.figure;
      h.gate = this.gate?.(c.vec);
      this.score(h);
    }
  }

  /** Keeps sources paging and the ranking pipeline fed just ahead of what's on screen. */
  private topUp() {
    if (this.ctl.signal.aborted || this.paused) return;
    let unseen = 0,
      ready = 0;
    const cold: Hit[] = [];
    for (const h of this.hits.values()) {
      if (h.shownAt !== undefined) continue;
      if (h.state === 'cold') cold.push(h);
      else if (h.state === 'queued') ready++;
      else if (h.state === 'ranked' && this.passes(h)) ready++;
      if (h.state !== 'dropped') unseen++;
    }
    if (unseen < LOW_WATER) for (const st of this.srcs) void this.fetchPage(st);
    const ahead = this.input.sketch ? AHEAD * 2 : AHEAD; // most candidates won't match a pose: look at more
    if (ready >= ahead || !cold.length || visionFailed()) return;
    cold.sort((a, b) => b.prelim - a.prelim);
    for (const h of cold.slice(0, ahead - ready)) this.embed(h);
  }

  private embed(h: Hit) {
    h.state = 'queued';
    this.inflight++;
    // each source's own best results get looked at early, so no source ranks late just for answering late
    const nth = (this.perSrcQueued.get(h.c.src) ?? 0) + 1;
    this.perSrcQueued.set(h.c.src, nth);
    const figures = this.wantsFigures();
    const direct = !!SOURCE_BY_ID[h.c.src]?.corsThumb; // readable as-is (the worker crops for the look model itself)
    const url = direct ? (h.c.rankThumb ?? h.c.thumb) : rankUrl(h.c.rankThumb ?? h.c.thumb, figures);
    if (!url) {
      this.fail(h);
      return;
    }
    embedUrl(url, (nth <= 6 ? 50 : 0) + h.prelim * 100, this.ctl.signal, figures)
      .then((emb) => {
        if (this.ctl.signal.aborted) return;
        h.vec = emb.vecs[0];
        if (figures) {
          const sk = emb.kps && emb.pad ? fromMoveNet(emb.kps, emb.pad) : null;
          h.figure = !!sk;
          if (this.input.pose) h.pose = sk ? poseMatch(this.input.pose, sk) : 0;
        }
        h.gate = this.gate?.(h.vec);
        this.score(h);
      })
      .catch(() => {
        if (!this.ctl.signal.aborted) this.fail(h);
      })
      .finally(() => {
        this.inflight--;
        this.topUp();
        this.notify();
      });
  }
  private fail(h: Hit) {
    h.state = 'dropped';
    h.why = 'broken';
  }

  // ---------------------------------------------------------------- batches
  /** The next batch. The first waits (briefly) for ranking so the first screen is already good. */
  async next(n = BATCH): Promise<Hit[]> {
    await this.started;
    const now0 = performance.now();
    const first = this.shown.length === 0;
    const budget = first ? (this.input.sketch ? SKETCH_WAIT : FIRST_WAIT) - (now0 - this.t0) : NEXT_WAIT;
    const deadline = now0 + Math.max(300, budget);
    for (;;) {
      if (this.ctl.signal.aborted) return [];
      this.topUp();
      const pool: Hit[] = [];
      let ranked = 0;
      const web = new Set<SourceId>();
      for (const h of this.hits.values()) {
        if (h.shownAt !== undefined || h.state === 'dropped') continue;
        if (h.state === 'ranked') {
          if (this.passes(h)) {
            pool.push(h);
            ranked++;
            if (!SOURCE_BY_ID[h.c.src]?.local) web.add(h.c.src);
          }
        } else pool.push(h);
      }
      // the instant catalogs mustn't decide the first screen alone: wait for the web to arrive too
      const webIn = !first || web.size >= WEB_SOURCES || this.srcs.every((s) => s.s.local || !s.busy);
      const now = performance.now();
      const late = now > deadline;
      if (first && !ranked && this.input.sketch && !this.nearestOnly && now - this.t0 > NEAREST_AFTER) {
        this.nearestOnly = true; // a rare pose: show the nearest figures rather than nothing
        continue;
      }
      // unranked results may only fill in when there's no ranking model (it failed, or is still
      // downloading on a slow connection) — never in pose searches, which need the figure check
      const modelMissing = visionFailed() || visionState().phase === 'loading';
      const fillUnranked = late && modelMissing && !this.wantsFigures();
      if ((webIn && (ranked >= n * 2 || (ranked >= n && now > deadline - 900))) || (late && ranked > 0) || (fillUnranked && pool.length > 0)) {
        const out = this.pick(pool, n, fillUnranked);
        if (out.length) return out;
      }
      if (this.exhausted()) return [];
      await this.wake(150);
    }
  }

  private pick(pool: Hit[], n: number, allowUnranked: boolean): Hit[] {
    const ranked = pool.filter((h) => h.state === 'ranked').sort((a, b) => this.total(b) - this.total(a));
    const rest = allowUnranked ? pool.filter((h) => h.state !== 'ranked').sort((a, b) => b.prelim - a.prelim) : [];
    const out: Hit[] = [],
      perSrc = new Map<SourceId, number>();
    const recent = this.shown
      .slice(-60)
      .map((h) => h.vec)
      .filter(Boolean) as Float32Array[];
    const local = (h: Hit) => !!SOURCE_BY_ID[h.c.src]?.local;
    const cap = (h: Hit) => (local(h) ? PER_LOCAL : PER_SOURCE);
    let locals = 0;
    const take = (h: Hit, strict: boolean) => {
      if (out.includes(h) || h.state === 'dropped') return;
      if (strict && ((perSrc.get(h.c.src) ?? 0) >= cap(h) || (local(h) && locals >= LOCAL_TOTAL))) return;
      if (h.vec)
        for (const r of recent.concat(out.map((o) => o.vec).filter(Boolean) as Float32Array[]))
          if (dot(h.vec, r) > 0.955) {
            h.state = 'dropped'; // near-identical to something already on screen (reprints, reposts)
            h.why = 'dupe';
            return;
          }
      out.push(h);
      perSrc.set(h.c.src, (perSrc.get(h.c.src) ?? 0) + 1);
      if (local(h)) locals++;
    };
    // More like this: the first screen starts with exactly what the viewer's Similar strip previewed
    if (!this.shown.length) for (const s of this.input.seed ?? []) if (out.length < n) { const h = this.hits.get(s.c.key); if (h) take(h, false); }
    for (const h of ranked) if (out.length < n) take(h, true);
    for (const h of rest) if (out.length < n) take(h, true);
    // only once nothing else is coming may one source fill the rest of a batch
    const moreComing = this.inflight > 0 || this.srcs.some((s) => s.busy || (s.more && s.fails < 3));
    if (!moreComing) for (const h of ranked) if (out.length < n) take(h, false);
    const now = performance.now();
    for (const h of out) {
      h.shownAt = now;
      this.shown.push(h);
    }
    this.topUp();
    this.notify();
    return out;
  }

  // ---------------------------------------------------------------- feedback
  vote(key: string, v: 'up' | 'down' | null) {
    const h = this.hits.get(key);
    const was = this.votes.get(key);
    if (was === 'down' && h) this.srcPenalty.set(h.c.src, Math.max(0, (this.srcPenalty.get(h.c.src) ?? 0) - 0.04));
    if (v) this.votes.set(key, v);
    else this.votes.delete(key);
    // a 👎 also makes its source count a little less for the rest of this search
    if (v === 'down' && h) this.srcPenalty.set(h.c.src, Math.min(0.12, (this.srcPenalty.get(h.c.src) ?? 0) + 0.04));
    this.rebuildQuery();
    this.notify();
  }
  picks() {
    return this.votes.size + (this.input.prior?.up.length ?? 0) + (this.input.prior?.down.length ?? 0);
  }
  /** 👍/👎 as vectors, to carry into the next search. */
  priorOut(): { up: Float32Array[]; down: Float32Array[] } {
    const pick = (want: 'up' | 'down') =>
      [...this.votes]
        .filter(([, x]) => x === want)
        .map(([k]) => this.hits.get(k)?.vec)
        .filter(Boolean) as Float32Array[];
    return { up: [...(this.input.prior?.up ?? []), ...pick('up')], down: [...(this.input.prior?.down ?? []), ...pick('down')] };
  }
  voteOf(key: string) {
    return this.votes.get(key);
  }
  /** Nearest ranked results to one result — the viewer's Similar strip and More like this's starting set. */
  similar(key: string, n = 6): Hit[] {
    const me = this.hits.get(key);
    if (!me?.vec) return [];
    const out: Array<[number, Hit]> = [];
    for (const h of this.hits.values()) {
      if (h === me || !h.vec || h.why === 'adult' || h.why === 'broken') continue;
      const s = dot(me.vec, h.vec);
      if (s > 0.95) continue; // the same picture again
      out.push([s, h]);
    }
    return out
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .map(([, h]) => h);
  }
  /** A result whose image won't load: take it out of the running. */
  broken(key: string) {
    const h = this.hits.get(key);
    if (h) this.fail(h);
  }
  modeUsed(): EffMode | undefined {
    return this.plan?.mode;
  }
}
