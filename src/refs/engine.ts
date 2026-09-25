/** One reference search: plans the query, asks every relevant source at once, ranks what comes back
 *  by how it looks (MobileCLIP) plus tags and source trust, and hands out batches of 10 as you scroll. */
import { rankUrl } from './net';
import { SOURCES } from './sources';
import type { Cand, EffMode, Mode, Plan, Source, SourceId } from './types';
import { embedBitmap, embedUrl, visionFailed, warmVision } from './vision';
import { DIM, gateScorer, imageWords, loadVocab, makePlan, normalize, queryVector, type Vocab } from './vocab';
import { describePose, fromMoveNet, poseSimilarity, type Skeleton } from './pose';

export interface Hit {
  c: Cand;
  prelim: number; // before the model has seen it: tags, source trust, the source's own order
  vec?: Float32Array;
  sim?: number; // match by look
  gate?: number; // > 0 = reads as adult
  pose?: number; // −1…1 match to the query pose (Pose searches only); −0.6 when no figure was found
  figure?: boolean; // MoveNet found a person (Pose-mode searches)
  shownAt?: number;
  dropped?: 'floor' | 'adult' | 'dupe' | 'broken';
}

export interface SearchInput {
  text: string;
  mode: Mode;
  adult: boolean;
  /** The user's image (already cropped), or a result's own vector for "More like this". */
  image?: ImageBitmap | Float32Array;
  mirror?: boolean;
  /** Words describing the image when there is no text (More like this passes the result's title). */
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
  plan?: Plan;
}

type SrcState = { s: Source; page: number; more: boolean; busy: boolean; fails: number };

const BATCH = 10;
const PER_SOURCE = 4; // at most this many from one source in a batch
const FIRST_WAIT = 2000; // ms: the first batch waits for 10 ranked results, at most this long
const NEXT_WAIT = 1200;
const LOW_WATER = 30; // ask sources for another page when fewer unseen ranked hits than this
const MAX_EMBED = 220; // per search, most promising first

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let d = 0; d < DIM; d++) s += a[d] * b[d];
  return s;
};

export class Search {
  plan?: Plan;
  private v?: Vocab;
  private q: Float32Array | null = null; // the combined query vector
  private qBase: Float32Array | null = null;
  private qMirror: Float32Array | null = null;
  private imageQuery = false;
  private hits = new Map<string, Hit>();
  private shown: Hit[] = [];
  private srcs: SrcState[] = [];
  private ctl = new AbortController();
  private t0 = performance.now();
  private embedded = 0;
  private queued = 0;
  private best = 0;
  private gate?: (e: Float32Array) => number;
  private votes = new Map<string, 'up' | 'down'>();
  private waiters: Array<() => void> = [];
  private started: Promise<void>;
  onChange: () => void = () => {};

  constructor(private input: SearchInput) {
    this.started = this.start();
    this.started.catch(() => this.notify());
  }

  get signal() {
    return this.ctl.signal;
  }

  abort() {
    this.ctl.abort();
    this.notify();
  }

  status(): Status {
    let ranked = 0;
    for (const h of this.hits.values()) if (h.vec) ranked++;
    return {
      shown: this.shown.length,
      ranked,
      found: this.hits.size,
      sourcesAsked: this.srcs.length,
      sourcesDone: this.srcs.filter((s) => !s.busy).length,
      exhausted: this.exhausted(),
      plan: this.plan,
    };
  }

  private exhausted() {
    return (
      this.srcs.length > 0 &&
      this.srcs.every((s) => !s.busy && (!s.more || s.fails >= 3)) &&
      this.unseen().length === 0 &&
      !this.embeddingPending()
    );
  }
  private embeddingPending() {
    return this.queued > this.embedded && !visionFailed();
  }

  private notify() {
    const w = this.waiters.splice(0);
    w.forEach((f) => f());
    this.onChange();
  }
  private wake(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  // ---------------------------------------------------------------- setup
  private async start() {
    void warmVision().catch(() => undefined);
    this.v = await loadVocab();
    const { text, mode, adult, image, mirror, hint } = this.input;
    let extra: string[] = [];
    if (this.input.sketch && this.input.pose) {
      // a stick figure looks like nothing else: its pose becomes the words, and ranking goes by pose
      extra = describePose(this.input.pose);
    } else if (image) {
      this.imageQuery = true;
      let vecs: Float32Array[];
      if (image instanceof Float32Array) vecs = [image];
      else vecs = (await embedBitmap(image, !!mirror)).vecs;
      this.qBase = vecs[0];
      this.qMirror = vecs[1] ?? null;
      if (!text.trim()) extra = await imageWords(this.v, vecs[0], 4);
    }
    this.plan = makePlan(this.v, text || hint || '', mode, adult, extra);
    if (!this.plan.text && extra.length) this.plan.text = extra.slice(0, 2).join(' ');
    const tq = await queryVector(this.v, this.plan);
    this.qText = tq;
    this.rebuildQuery();
    this.gate = await gateScorer(this.v).catch(() => undefined);
    for (const s of this.input.seed ?? []) {
      if (!s.vec || s.c.key === this.input.exclude || this.hits.has(s.c.key)) continue;
      const h: Hit = { c: s.c, prelim: s.prelim, vec: s.vec, sim: this.simOf(s.vec), gate: s.gate };
      this.hits.set(s.c.key, h);
      this.best = Math.max(this.best, h.sim!);
    }
    const m = this.plan.mode;
    const off = new Set(this.input.off ?? []);
    this.srcs = SOURCES.filter((s) => s.trust[m] >= 0.3 && !off.has(s.id))
      .sort((a, b) => b.trust[m] - a.trust[m])
      .map((s) => ({ s, page: 0, more: true, busy: false, fails: 0 }));
    for (const st of this.srcs) this.fetchPage(st);
    this.notify();
  }
  private qText: Float32Array | null = null;

  /** Text and image combine; 👍/👎 pull the query toward / away from what you picked. */
  private rebuildQuery() {
    const q = new Float32Array(DIM);
    const add = (v: Float32Array | null, w: number) => {
      if (v) for (let d = 0; d < DIM; d++) q[d] += v[d] * w;
    };
    if (this.qBase) add(this.qBase, 1);
    // More like this searches by the picture alone; its title only helps phrase the source queries
    if (this.qText && !(this.input.image instanceof Float32Array)) add(this.qText, this.qBase ? 0.55 : 1);
    const up = [...this.votes]
      .filter(([, v]) => v === 'up')
      .map(([k]) => this.hits.get(k)?.vec)
      .filter(Boolean) as Float32Array[];
    const down = [...this.votes]
      .filter(([, v]) => v === 'down')
      .map(([k]) => this.hits.get(k)?.vec)
      .filter(Boolean) as Float32Array[];
    const pu = this.input.prior?.up ?? [],
      pd = this.input.prior?.down ?? [];
    const allUp = [...up, ...pu],
      allDown = [...down, ...pd];
    for (const v of allUp) add(v, 0.4 / allUp.length);
    for (const v of allDown) add(v, -0.25 / allDown.length);
    let n = 0;
    for (const x of q) n += x * x;
    this.q = n > 0 ? normalize(q) : null;
    for (const h of this.hits.values()) if (h.vec) h.sim = this.simOf(h.vec);
  }

  private simOf(e: Float32Array): number {
    if (!this.q) return 0;
    let s = dot(this.q, e);
    if (this.qMirror && this.qBase) {
      // the same pose facing the other way scores as well as the original
      const alt = s - dot(this.qBase, e) + dot(this.qMirror, e);
      s = Math.max(s, alt);
    }
    return s;
  }

  // ---------------------------------------------------------------- sources
  private async fetchPage(st: SrcState) {
    if (st.busy || !st.more || st.fails >= 3 || this.ctl.signal.aborted || !this.plan) return;
    st.busy = true;
    try {
      const page = await st.s.search(this.plan, st.page, this.ctl.signal);
      st.page++;
      st.more = page.more;
      st.fails = 0;
      for (const c of page.items) this.add(c);
    } catch {
      if (!this.ctl.signal.aborted) {
        st.fails++;
        st.more = st.fails < 3 && st.page === 0 ? true : st.more;
        if (st.fails >= 3) st.more = false;
      }
    } finally {
      st.busy = false;
      this.notify();
    }
  }

  private add(c: Cand) {
    if (!c.thumb || this.hits.has(c.key) || c.key === this.input.exclude) return;
    const m = this.plan!.mode;
    const tw = new Set([...c.tags, ...c.title.toLowerCase().split(/[^a-z0-9]+/)]);
    const ws = this.plan!.words;
    const tm = ws.length ? ws.filter((w) => tw.has(w)).length / ws.length : 0;
    const trust = SOURCES.find((s) => s.id === c.src)?.trust[m] ?? 0.3;
    const h: Hit = { c, prelim: 0.5 * tm + 0.35 * trust + 0.15 / (1 + c.pos / 8) };
    if (c.adult && !this.plan!.adult) h.dropped = 'adult';
    this.hits.set(c.key, h);
    if (!h.dropped && this.queued < MAX_EMBED) this.embed(h);
  }

  private perSrcQueued = new Map<SourceId, number>();
  private embed(h: Hit) {
    if (visionFailed()) return;
    this.queued++;
    // every source's own best results get looked at early, so no source is ranked late just for answering late
    const nth = (this.perSrcQueued.get(h.c.src) ?? 0) + 1;
    this.perSrcQueued.set(h.c.src, nth);
    const fair = nth <= 6 ? 50 : 0;
    const figures = this.wantsFigures();
    const url = rankUrl(h.c.rankThumb ?? h.c.thumb, figures);
    if (!url) {
      h.dropped = 'broken';
      return;
    }
    embedUrl(url, fair + h.prelim * 100 - this.queued * 0.01, this.ctl.signal, figures)
      .then((emb) => {
        const vec = emb.vecs[0];
        h.vec = vec;
        if (figures) {
          const sk = emb.kps && emb.pad ? fromMoveNet(emb.kps, emb.pad) : null;
          h.figure = !!sk;
        }
        if (figures && this.input.pose) {
          const sk = emb.kps && emb.pad ? fromMoveNet(emb.kps, emb.pad) : null;
          h.pose = sk ? poseSimilarity(this.input.pose, sk) : -0.6;
          // a stick-figure search is about the pose: no figure, or a clearly different pose, isn't a match
          if (this.input.sketch && h.pose < POSE_MIN) h.dropped = 'floor';
        }
        h.sim = this.simOf(vec);
        h.gate = this.gate?.(vec);
        if (!this.plan!.adult && (h.gate ?? -1) > GATE_T) h.dropped = 'adult';
        if (!h.dropped) this.best = Math.max(this.best, h.sim);
      })
      .catch(() => {
        if (!this.ctl.signal.aborted) h.dropped ??= 'broken';
      })
      .finally(() => {
        this.embedded++;
        this.notify();
      });
  }

  // ---------------------------------------------------------------- ranking
  /** Relevance floor: absolute minimum, and not far below the best match found so far. */
  private floor() {
    if (!this.q) return -1;
    if (this.input.pose) return Math.max(0.08, this.best - 0.2); // pose searches rank mostly by the figure
    return this.imageQuery ? Math.max(0.3, this.best - 0.32) : Math.max(0.15, this.best - 0.13);
  }
  /** Pose searches look for a person in every result (MoveNet runs beside the ranking model). */
  private wantsFigures() {
    return !!this.input.pose || this.plan?.mode === 'pose';
  }
  private score(h: Hit) {
    if (h.sim === undefined) return -1 + h.prelim;
    const poseW = this.input.sketch ? 0.35 : 0.2;
    const noFigure = this.wantsFigures() && h.figure === false ? 0.16 : 0; // a lone sword isn't a pose reference
    return h.sim + 0.03 * h.prelim + (this.input.pose ? poseW * (h.pose ?? -0.6) : 0) - noFigure;
  }
  private unseen(): Hit[] {
    const f = this.floor();
    const out: Hit[] = [];
    for (const h of this.hits.values()) {
      if (h.shownAt !== undefined || h.dropped) continue;
      if (h.sim !== undefined && h.sim < f) continue;
      out.push(h);
    }
    return out;
  }

  /** The next batch of results. Waits (briefly) for ranking so the first screen is already good. */
  async next(n = BATCH): Promise<Hit[]> {
    await this.started;
    const posed = this.wantsFigures(); // Pose searches only ever show results the figure check has seen
    const wait = this.shown.length ? NEXT_WAIT : (this.input.sketch ? 3000 : FIRST_WAIT) - (performance.now() - this.t0);
    const deadline = performance.now() + (posed && this.shown.length ? NEXT_WAIT * 1.5 : wait);
    for (;;) {
      if (this.ctl.signal.aborted) return [];
      const pool = this.unseen();
      const ranked = pool.filter((h) => h.vec);
      if (pool.length < LOW_WATER) for (const st of this.srcs) this.fetchPage(st);
      const allIn = this.srcs.every((s) => !s.busy) && !this.embeddingPending();
      const noModel = visionFailed() || !this.q;
      const late = performance.now() > deadline;
      if (
        ranked.length >= n * 2 ||
        (ranked.length >= n && performance.now() > deadline - 900) ||
        (late && pool.length >= 1) ||
        (allIn && (noModel || pool.every((h) => h.vec)))
      ) {
        return this.pick(pool, n, !posed && (late || noModel));
      }
      if (this.exhausted()) return [];
      await Promise.race([this.wake(), new Promise((r) => setTimeout(r, 120))]);
    }
  }

  private pick(pool: Hit[], n: number, allowUnranked: boolean): Hit[] {
    const ranked = pool.filter((h) => h.vec).sort((a, b) => this.score(b) - this.score(a));
    const rest = allowUnranked ? pool.filter((h) => !h.vec).sort((a, b) => b.prelim - a.prelim) : [];
    const out: Hit[] = [],
      perSrc = new Map<SourceId, number>();
    const recent = this.shown
      .slice(-40)
      .map((h) => h.vec)
      .filter(Boolean) as Float32Array[];
    const take = (h: Hit, strict: boolean) => {
      if ((perSrc.get(h.c.src) ?? 0) >= PER_SOURCE && strict) return false;
      if (h.vec) {
        // near-identical to something already on screen (reprints, reposts): skip it for good
        for (const r of [...recent, ...(out.map((o) => o.vec).filter(Boolean) as Float32Array[])])
          if (dot(h.vec, r) > 0.955) {
            h.dropped = 'dupe';
            return false;
          }
      }
      out.push(h);
      perSrc.set(h.c.src, (perSrc.get(h.c.src) ?? 0) + 1);
      return true;
    };
    // More like this: the first screen starts with exactly what the viewer's Similar strip previewed
    if (!this.shown.length)
      for (const s of this.input.seed ?? []) {
        const h = this.hits.get(s.c.key);
        if (h && !h.dropped && out.length < n && !out.includes(h)) take(h, false);
      }
    for (const h of ranked) {
      if (out.length >= n) break;
      if (!out.includes(h)) take(h, true);
    }
    for (const h of rest) {
      if (out.length >= n) break;
      take(h, true);
    }
    for (const h of ranked) {
      if (out.length >= n) break;
      if (!out.includes(h) && !h.dropped) take(h, false);
    }
    const now = performance.now();
    for (const h of out) {
      h.shownAt = now;
      this.shown.push(h);
    }
    this.notify();
    return out;
  }

  // ---------------------------------------------------------------- feedback
  vote(key: string, v: 'up' | 'down' | null) {
    if (v) this.votes.set(key, v);
    else this.votes.delete(key);
    this.rebuildQuery();
    this.best = 0;
    for (const h of this.hits.values()) if (h.sim !== undefined && !h.dropped) this.best = Math.max(this.best, h.sim);
    this.notify();
  }
  picks() {
    return this.votes.size + (this.input.prior?.up.length ?? 0) + (this.input.prior?.down.length ?? 0);
  }
  /** 👍/👎 as vectors, to carry into the next search. */
  priorOut(): { up: Float32Array[]; down: Float32Array[] } {
    const pick = (want: 'up' | 'down') =>
      [...this.votes]
        .filter(([, v]) => v === want)
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
      if (h === me || !h.vec || h.dropped === 'adult' || h.dropped === 'broken') continue;
      const s = dot(me.vec, h.vec);
      if (s > 0.97) continue; // the same picture again
      out.push([s, h]);
    }
    return out
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .map(([, h]) => h);
  }
  hit(key: string) {
    return this.hits.get(key);
  }
  modeUsed(): EffMode | undefined {
    return this.plan?.mode;
  }
}

/** Stick-figure searches keep only figures whose limbs point roughly the same way (−1…1 scale). */
const POSE_MIN = 0.45;
/** Gate threshold: calibrated on the gauntlet's adult-content set. */
const GATE_T = 0.02;
