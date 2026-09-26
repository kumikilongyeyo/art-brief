/** Reference pictures for a brief: 5–10 pictures of what it describes, the subject first and then a few for
 *  its parts (look, wearing, pose, setting, mood…). Each part is its own tight search, ranked by the picture
 *  model against that part's words, over sources that post polished work, so the board shows what the brief
 *  means rather than whatever a long blended query happens to hit. */
import type { Brief, DataSet, RefPick, SlotId } from '../engine/types';
import { ADULT_WORDS, Search, type Hit } from './engine';
import { visionFailed } from './vision';
import { getJson, RELAY } from './net';
import { SOURCE_BY_ID, SOURCES } from './sources';
import { segment, type Vocab } from './vocab';
import type { EffMode, SourceId } from './types';

export interface Part {
  id: string;
  label: string; // what the tiles are of ("Subject", "Wearing"…)
  /** Ways to ask for it, most specific first: the first one the art sites know enough work for is used. */
  tries: string[];
  query: string; // the one used (tries[0] until resolved)
  mode: EffMode;
  n: number; // pictures of it on the board
  kind: 'figure' | 'pose' | 'animal' | 'place' | 'thing' | 'mood' | 'render';
  /** Only these sources (the render section: one style, from one source). */
  only?: SourceId[];
}

/** How finished the picture should look, each from the one source that defines it, so the Render section
 *  is one consistent style rather than a mix. */
export const STYLES = [
  { id: 'hearthstone', label: 'Stylized · Hearthstone', src: 'hearthstone' },
  { id: 'lol', label: 'Semi-realistic · League splash art', src: 'lol' },
  { id: 'mtg', label: 'Painterly realism · Magic', src: 'scryfall' },
  { id: 'fab', label: 'Grounded realism · Flesh and Blood', src: 'fab' },
  { id: 'lorcana', label: 'Cartoony · Lorcana', src: 'lorcana' },
] as const satisfies ReadonlyArray<{ id: string; label: string; src: SourceId }>;
export type StyleId = (typeof STYLES)[number]['id'];
/** The style a brief's job suggests (a TCG card is painted like Magic, a key frame like a League splash). */
export function defaultStyle(brief: Brief): StyleId {
  const job = `${brief.job ?? ''} ${brief.art?.purpose ?? ''}`.toLowerCase();
  if (/tcg|card|codex|chapter|book|environment/.test(job)) return 'mtg';
  if (/key ?frame|cinematic|cover|splash|poster/.test(job)) return 'lol';
  return 'hearthstone'; // turnarounds, miniatures, vignettes: stylized reads best
}

/** Where each kind of part looks: sites that post finished, current illustration (and, for places and
 *  materials, good photography). Random reposts, wallpapers of people and low-resolution scans are left out. */
const WHERE: Record<Part['kind'], SourceId[]> = {
  // (Pokémon answers creature parts only: in any other mode its trust is under the engine's 0.3 floor)
  figure: ['artstation', 'lol', 'hearthstone', 'riftbound', 'fab', 'scryfall', 'dnd', 'lorcana', 'forgottenrealms', 'criticalrole', 'pathfinder', 'warhammer', 'pokemon'],
  // whole figures: the pose library's photos and full-length character art (splash art is mostly cropped)
  pose: ['artstation', 'poses', 'forgottenrealms', 'dnd', 'pathfinder', 'criticalrole', 'flickr', 'pexels'],
  // a creature's anatomy: real animals first (photographs), then creature designs
  animal: ['artstation', 'flickr', 'pexels', 'inat'],
  place: ['artstation', 'scryfall', 'hearthstone', 'riftbound', 'wallhaven', 'openverse', 'lol', 'flickr', 'pexels'],
  thing: ['artstation', 'hearthstone', 'scryfall', 'riftbound', 'fab', 'cleveland', 'artsmia', 'met', 'openverse', 'flickr', 'pexels'],
  mood: ['artstation', 'scryfall', 'wallhaven', 'hearthstone', 'lol', 'fab'],
  render: [], // always a part's `only`
};
const offFor = (p: Part) => SOURCES.map((s) => s.id).filter((id) => !(p.only ?? WHERE[p.kind]).includes(id));

const LEAD = /^(a|an|the|its|their|his|her|one|two|some)\s+/;
const TAIL = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'to', 'for', 'with', 'from', 'into', 'over', 'under', 'through', 'and', 'or', 'its', 'their', 'his', 'her', 'like', 'shaped', 'as']);
const NOUN_ING = new Set(['building', 'ceiling', 'painting', 'clearing', 'landing', 'ring', 'king', 'wing', 'string', 'spring', 'sling', 'offering', 'bed', 'shed', 'sled', 'seed', 'reed', 'steed', 'lung', 'dung', 'rung']);
const CLAUSE = /,|;| while | that | which | who | where | as if | until | when | because /;
const PREP = / with | and | of | in | on | at | by | through | beneath | above | below | between | from | around | under | into | across | behind | near | over | like | shaped | for | before | after | inside | woven | tied | trailing /;

/** The heart of a descriptive line, as a short searchable phrase: the part before its first comma or
 *  clause, and for long lines the part before its first preposition too ("robed scholar with a fat
 *  spellbook" → "robed scholar", "seams of molten light between its plates" → "seams of molten light"). */
export function core(text = '', max = 4): string {
  let t = text.toLowerCase().replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').split(CLAUSE)[0].trim();
  const n = (x: string) => x.split(' ').length;
  if (n(t) > max) {
    // cut at the first preposition that leaves at least two words ("seams of molten light" keeps 'of'
    // when the cut would leave just "seams")
    const parts = t.split(PREP);
    t = n(parts[0]) >= 2 || parts.length < 2 ? parts[0] : t.split(PREP).slice(0, 2).join(' ').trim();
  }
  let ws = t.replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((w) => w && !LEAD.test(`${w} `)).slice(0, max);
  // …and without a dangling verb ("jungle canopy strung" → "jungle canopy", "stones leaning")
  const dangling = (w: string) => TAIL.has(w) || (!w.includes('-') && /(ed|ung|ing)$/.test(w) && !NOUN_ING.has(w)) || ['lit', 'left', 'built', 'torn', 'worn', 'set'].includes(w);
  while (ws.length > 1 && dangling(ws[ws.length - 1])) ws = ws.slice(0, -1);
  return ws.join(' ');
}

/** An entry's short name ("Half-Orc", "Fighter", "Library"), from the data table behind a slot. */
function labelOf(data: DataSet, brief: Brief, slot: SlotId): string {
  const f = brief.fields[slot];
  if (!f) return '';
  const def = data.categories[brief.category]?.slots.find((s) => s.id === slot);
  const entry = def?.table ? data.tables[def.table]?.entries.find((e) => e.id === f.entryId) : undefined;
  return (entry?.label ?? f.text).toLowerCase();
}

/** Shorter ways to say a phrase: all of it, then its last two words (the noun and what kind: "old-growth
 *  forest", "jungle canopy"), its first two, and its last word. */
export function variants(phrase: string): string[] {
  const w = phrase.split(' ').filter(Boolean);
  // one bare word finds anything ("roof" → roof textures): alone it's asked as fantasy art
  const one = w.length > 1 ? `fantasy ${w[w.length - 1]}` : w[0] ?? '';
  return [...new Set([w.join(' '), w.slice(-2).join(' '), w.slice(0, 2).join(' '), one])].filter((x) => x && !TAIL.has(x));
}
/** What state a building is in, as the word its pictures are titled with. */
const CONDITIONS: Array<[RegExp, string]> = [
  [/ruin|crumbl|collaps|broken|shatter/, 'ruined'], [/overgrown|roots|ivy|moss|vines/, 'overgrown'], [/flood|sunken|submerged/, 'flooded'],
  [/burn|charred|fire|scorch/, 'burned'], [/abandon|squat|empty|derelict|deserted/, 'abandoned'], [/haunt|ghost/, 'haunted'],
  [/frozen|ice|snow|frost/, 'frozen'], [/fortif|barricad|besieg|siege/, 'fortified'], [/new|pristine|fresh|gleaming|restored/, 'grand'],
  [/scaffold|unfinished|construction/, 'under construction'],
];
const conditionWord = (text: string) => CONDITIONS.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? '';
/** A place line's noun phrases, split where a preposition joins them ("black-smoker vents in an abyssal
 *  trench" → black-smoker vents, abyssal trench), then shorter ways to say the first. Two-word phrases
 *  first: art sites find little under long ones and anything at all under one word. */
export function placeTries(text: string): string[] {
  const clause = text.toLowerCase().replace(/\{[^}]*\}/g, ' ').split(CLAUSE)[0];
  const chunks = clause
    .split(PREP)
    .map((c) => core(c, 3))
    .filter(Boolean);
  const first = chunks[0] ?? '';
  const w = first.split(' ');
  return uniq([...chunks.filter((c) => c.includes(' ')), w.slice(-2).join(' '), w.length > 1 ? `fantasy ${w[w.length - 1]}` : '', ...chunks]);
}
/** D&D creature types as words art sites use. */
const CREATURE_WORD: Record<string, string> = {
  aberration: 'eldritch horror', beast: 'beast', celestial: 'celestial being', construct: 'golem', dragon: 'dragon', elemental: 'elemental',
  fey: 'fey creature', fiend: 'demon', giant: 'giant', humanoid: 'creature', monstrosity: 'monster', ooze: 'slime monster', plant: 'plant monster', undead: 'undead',
};
const DISTINCT_KINDS = new Set(['aberration', 'celestial', 'construct', 'dragon', 'elemental', 'fey', 'fiend', 'ooze', 'plant', 'undead']);
/** "School of Necromancy" → "necromancy", "Tempest Domain" → "tempest", "Oath of Vengeance" → "vengeance". */
const subclassWord = (s: string) => s.replace(/\b(school|college|oath|circle|path|way|domain|patron|order|the|of|conclave)\b/g, ' ').replace(/\s+/g, ' ').trim();
/** The first word of a line that the vocabulary files under a kind ('prop', 'creature', 'figure'…). */
function wordOf(v: Vocab | undefined, text: string, cat: string): string {
  if (!v) return '';
  return segment(v, text.replace(/\{[^}]*\}/g, ' ')).find((k) => v.catOf(k) === cat) ?? '';
}
const GERUNDS = new Set(
  'crouching kneeling leaping jumping running sitting standing perching lunging falling flying climbing fighting casting praying reading walking dancing hurling throwing aiming swinging charging hiding sneaking floating meditating resting lying reaching pointing striding rolling diving spinning balancing hanging riding drinking sleeping kicking blocking dodging parrying laughing shouting screaming singing playing drawing pulling pushing carrying lifting stretching bowing crawling'.split(' '),
);
/** "crouched" → "crouching", "leaps" → "leaping": how pose references are titled (only for pose words). */
export function ing(w: string): string {
  const c = [w, w.replace(/ed$/, 'ing'), w.replace(/([^aeiou])\1ed$/, '$1ing'), w.replace(/d$/, 'ing'), w.replace(/s$/, 'ing'), w.replace(/ed$/, 'eing')];
  return c.find((x) => GERUNDS.has(x)) ?? w;
}
/** The lighting a line asks for, in the words artists title their studies with. */
const LIGHTS: Array<[RegExp, string]> = [
  // the most particular first: "dusk thunderstorm" is a storm before it's a dusk
  [/lightning|thunder|storm/, 'lightning storm'], [/rim[- ]?l/, 'rim light'], [/backlit|backlight|silhouette/, 'backlit'], [/candle/, 'candlelight'],
  [/lantern|lamp/, 'lantern light'], [/fire|torch|hearth|furnace|forge|ember/, 'firelight'], [/moon/, 'moonlight'], [/dappled|leaves|canopy/, 'dappled light'],
  [/ray|shaft|beam/, 'god rays'], [/underlit|from below|below/, 'underlighting'], [/glow|biolum/, 'glowing light'], [/fog|mist|haze/, 'misty light'],
  [/noon|midday|hard sun|harsh/, 'harsh sunlight'], [/golden|sunset|dusk|evening/, 'golden hour'], [/dawn|sunrise/, 'dawn light'],
  [/overcast|grey|gray|rain/, 'overcast light'], [/neon/, 'neon light'], [/cold|blue|ice|frost/, 'cold light'], [/warm|amber|orange/, 'warm light'],
  [/low-key|dark|shadow/, 'chiaroscuro'],
];
/** How a shot is framed, in the words artists title studies with. */
const FRAMES: Array<[RegExp, string]> = [
  [/dutch|tilted|canted/, 'dutch angle'], [/worm|low angle|from below|looking up/, 'low angle'], [/bird|overhead|from above|top-down|high angle/, 'high angle'],
  [/close-up|close up|tight|faces filling|hands/, 'close-up'], [/wide|vista|panoram|establishing|tiny figures?/, 'wide shot'],
  [/over the shoulder|over-the-shoulder/, 'over the shoulder'], [/silhouette|backlight|rim-lit/, 'silhouette'], [/symmetr|centred|centered/, 'symmetrical composition'],
  [/split|half|divided/, 'split lighting'], [/foreground|framed by|through a|doorway|window/, 'framed composition'], [/eye level|intimate/, 'eye level'],
];
const frameWord = (text: string) => FRAMES.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? '';
export const lightWord = (text: string) => LIGHTS.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? '';
/** Who made it, as an adjective art is titled with: "high-elven star college" → "elven". */
const CULTURES: Array<[RegExp, string]> = [
  [/\b(high-)?el(f|ven|ves)\b|\bdrow\b/, 'elven'], [/\bdwar(f|ven|ves)\b/, 'dwarven'], [/\borc(s|ish)?\b/, 'orcish'], [/\bgoblin/, 'goblin'],
  [/\bgnom/, 'gnomish'], [/\bdragon/, 'draconic'], [/\binfernal|\bdevil|\bhell|\btiefling/, 'infernal'], [/celestia|\bangel|\bholy|\btemple/, 'holy'],
  [/\bfey|\bfae|feywild/, 'fey'], [/shadowfell|\bshadow|\bmourning|\bdeath|necro/, 'dark'], [/\bgiant/, 'giant'], [/\bpirate|\bsea\b|\bcorsair/, 'pirate'],
  [/\bimperial|\bempire|\bcourt/, 'royal'], [/\bnomad|\bdesert/, 'desert'], [/\bnorth|\bfrost|\bice\b/, 'nordic'], [/\bwizard|\barcane|\bcollege|\bmage/, 'arcane'],
];
const cultureOf = (text: string) => CULTURES.find(([re]) => re.test(text.toLowerCase()))?.[1] ?? '';
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length > 2))];

/** The searches a brief's board is made of, subject first. `v` (the search vocabulary) lets it pick out
 *  the props, creatures and people a line mentions; without it the lines' own words are used. */
export function partsFor(data: DataSet, brief: Brief, v?: Vocab, style: StyleId = defaultStyle(brief)): Part[] {
  const t = (slot: SlotId) => (brief.fields[slot]?.text ?? '').replace(/\{[^}]*\}/g, ' ');
  const L = (slot: SlotId) => labelOf(data, brief, slot);
  const light = core(brief.art?.light ?? '', 3);
  const lw = lightWord(brief.art?.light ?? '');
  const lit = (noun: string) => (lw ? [`${lw} ${noun}`, `${lw} fantasy`, `${lw} painting`, lw] : light ? [`${light} ${noun}`, light] : []);
  const P = (id: string, label: string, tries: string[], mode: EffMode, n: number, kind: Part['kind']): Part | null => {
    const q = uniq(tries);
    return q.length ? { id, label, tries: q, query: q[0], mode, n, kind } : null;
  };
  let parts: (Part | null)[] = [];
  switch (brief.category) {
    case 'character': {
      const S = L('species'),
        C = L('class'),
        SC = subclassWord(L('subclass'));
      const tail = core((t('species').split(',').pop() ?? '').trim(), 3); // "pointed ears", "bat-wing ears"
      const outfit = core(t('outfit'), 3);
      const gear = wordOf(v, `${t('class')} ${t('subclass')}`, 'prop');
      // the action in the line, however it's worded: "head thrown back laughing" → laughing
      const pw = t('pose').toLowerCase().split(/[^a-z-]+/).filter(Boolean);
      const ai = pw.map(ing).findIndex((w) => GERUNDS.has(w) || (/[a-z]{3}ing$/.test(w) && !NOUN_ING.has(w)));
      const act = ai >= 0 ? ing(pw[ai]) : '';
      // …with what it acts on ("drawing a bow" is an archer, "drawing" alone finds sketches)
      const obj = ai >= 0 ? (pw.slice(ai + 1).find((w) => w.length > 2 && !TAIL.has(w) && !LEAD.test(`${w} `)) ?? '') : '';
      const pose = act || core(t('pose'), 2);
      parts = [
        P('subject', 'Subject', [`${S} ${C}`, `fantasy ${C}`, C], 'pose', 2, 'figure'),
        P('class', SC ? 'Subclass' : 'Class', [`${SC} ${C}`, `${SC}`, `${C} character`], 'pose', 1, 'figure'),
        P('look', 'Look', [`${S} portrait`, `${S} ${tail}`, `${S} character`], 'pose', 1, 'figure'),
        P('wearing', 'Wearing', [outfit, ...variants(outfit).slice(1, 2).filter((x) => x.includes(' ')), `${outfit} outfit`, `${C} outfit`], 'pose', 1, 'figure'),
        P('pose', 'Pose', [...(act && obj ? [`${act} ${obj}`, `${act} ${obj} pose`] : []), `${pose} pose`, `${ing(pose.split(' ')[0])} pose`, `${ing(pose.split(' ')[0])} ${C}`, `${C} action pose`], 'pose', 1, 'pose'),
        P('gear', 'Gear', gear ? [`fantasy ${gear}`, gear] : [], 'prop', 1, 'thing'),
        P('mood', 'Light', lit('portrait'), 'concept', 1, 'mood'),
      ];
      break;
    }
    case 'creature': {
      const T = CREATURE_WORD[L('creatureType')] ?? (L('creatureType') || 'creature');
      // "barrel-chested winged quadruped": the last word is what it is, the ones before are how it's built
      const body = core(t('bodyPlan').replace(/,/g, ' '), 4).split(' ');
      const head = body[body.length - 1] ?? '';
      // the feature it's built around, whole ("eight-legged", "long-necked", "winged")
      const mods = body.slice(0, -1).filter((m) => m.length > 3 && !/^(barrel|big|small|huge|tiny)-/.test(m));
      const feature = [...mods].reverse().find((m) => /ed$|less$|ish$|ous$|ful$/.test(m)) ?? mods[mods.length - 1] ?? '';
      parts = [
        P('subject', 'Subject', [`${head} creature`, `${body.join(' ')} creature`, `${T} creature`], 'creature', 2, 'figure'),
        P('body', 'Body', feature ? [`${feature} ${head}`, `${feature} creature`] : [], 'creature', 1, 'figure'),
        // only the kinds that change how it looks (a beast or a monstrosity says nothing a picture could show)
        P('type', 'Kind', DISTINCT_KINDS.has(L('creatureType')) ? [`${T} creature`, `${T} concept art`, T] : [], 'creature', 1, 'figure'),
        P('anatomy', 'Anatomy', [`${head} anatomy`, `creature anatomy`], 'creature', 1, 'animal'),
        P('habitat', 'Habitat', placeTries(t('habitat')), 'place', 2, 'place'),
        P('mood', 'Light', lit('creature'), 'concept', 1, 'mood'),
      ];
      break;
    }
    case 'prop': {
      const O = L('objectType') || core(t('objectType'), 2);
      const mat = wordOf(v, t('material'), 'material') || core(t('material'), 2);
      const origin = core(t('origin'), 3);
      const detail = core(t('details'), 2);
      const who = cultureOf(t('origin'));
      const o1 = O.split(' ').pop()!;
      parts = [
        P('subject', 'Subject', [`fantasy ${O}`, O], 'prop', 3, 'thing'),
        P('sheet', 'Design', [`${O} design sheet`, `${O} concept art`, `${O} concept`], 'prop', 1, 'thing'),
        P('culture', 'Made by', who ? [`${who} ${o1}`, `${who} artifact`, `${who} ornament`] : [], 'prop', 1, 'thing'),
        P('material', 'Material', [`${mat} ${o1}`, `${mat} texture`, mat], 'prop', 1, 'thing'),
        P('detail', 'Detail', [`${detail} ${o1}`, `ornate ${o1}`, `${o1} details`], 'prop', 1, 'thing'),
        P('origin', 'Origin', [who && `${who} ${origin.split(' ').pop()}`, ...placeTries(t('origin'))], 'place', 1, 'place'),
      ];
      break;
    }
    case 'building': {
      const F = L('function') || core(t('function'), 2);
      const f1 = F.split(' ').pop()!;
      const style = core(t('style'), 3); // "half-timbered market-town": its hyphenated words stay whole
      const s0 = style.split(' ')[0],
        sN = style.split(' ').pop()!;
      const cw = conditionWord(t('condition'));
      parts = [
        P('subject', 'Subject', [`${style} ${f1}`, `${s0} ${f1}`, `${sN} ${f1}`, `fantasy ${F}`, F], 'place', 3, 'place'),
        // "salt-bleached fishing-village": a fishing village shows the style better than any phrase for it
        P('style', 'Style', [`${style} architecture`, `${sN} architecture`, sN.replace(/-/g, ' '), `${s0} architecture`, s0.replace(/-/g, ' ')], 'place', 1, 'place'),
        P('setting', 'Setting', placeTries(t('setting')), 'place', 2, 'place'),
        P('feature', 'Feature', variants(core(t('feature'), 3)).slice(0, 3), 'place', 1, 'place'),
        P('condition', 'Condition', cw ? [`${cw} ${f1}`, `${cw} building`, `fantasy ${cw} building`] : [], 'place', 1, 'place'),
      ];
      break;
    }
    case 'scene': {
      const figs = v ? segment(v, t('event')).filter((k) => v.catOf(k) === 'figure') : [];
      const time = core(t('time'), 3);
      parts = [
        P('subject', 'Subject', placeTries(t('location')), 'place', 3, 'place'),
        P('who', 'Figures', figs[0] ? [`${figs[0]} ${figs[1] ?? ''}`, `fantasy ${figs[0]}`, figs[0]] : variants(core(t('event'), 3)), 'pose', 1, 'figure'),
        P('who2', 'Figures', figs[1] ? [`fantasy ${figs[figs.length - 1]}`, figs[figs.length - 1]] : [], 'pose', 1, 'figure'),
        P('time', 'Time', [...variants(time).slice(0, 2), lightWord(time) && `${lightWord(time)} landscape`, `${time.split(' ').pop()} landscape`], 'place', 1, 'mood'),
        P('mood', 'Mood', [`${core(t('mood'), 2)} fantasy art`, `${core(t('mood'), 2)} painting`, core(t('mood'), 2)], 'concept', 1, 'mood'),
        P('framing', 'Framing', frameWord(t('composition')) ? [`${frameWord(t('composition'))} illustration`, `${frameWord(t('composition'))} fantasy`, frameWord(t('composition'))] : [], 'concept', 1, 'mood'),
      ];
      break;
    }
  }
  // the render section: the subject again, in the one chosen style
  const subject = parts.find((p) => p?.id === 'subject');
  const st = STYLES.find((x) => x.id === style) ?? STYLES[0];
  if (subject) parts.push({ ...subject, id: 'render', label: 'Render', tries: subject.tries, query: subject.tries[0], mode: 'concept', n: 2, kind: 'render', only: [st.src] });
  return parts.filter((p): p is Part => !!p);
}

const known = new Map<string, Promise<number>>();
/** How much work ArtStation has under these words (it holds most of the current, polished work; a phrasing
 *  it barely knows is one the other sites won't know either). */
function artstationCount(q: string, signal: AbortSignal): Promise<number> {
  if (!RELAY) return Promise.resolve(-1);
  if (!known.has(q)) {
    const p = getJson<{ total_count?: number }>(`${RELAY}/artstation?q=${encodeURIComponent(q)}&page=1&n=30`, signal, 8000).then((r) => r.total_count ?? 0);
    p.catch(() => known.delete(q));
    known.set(q, p);
  }
  return known.get(q)!;
}
/** The first of a part's phrasings with enough work behind it (or the one with the most). All are asked at
 *  once; the relay caches them, and the search then reuses the chosen one's answer. */
export async function resolve(part: Part, signal: AbortSignal, enough = 12): Promise<Part> {
  if (!RELAY) return part; // nothing to ask: use the most specific words
  if (part.only && !part.only.includes('artstation')) return part; // ArtStation's counts say nothing about a card game's
  const counts = await Promise.all(part.tries.map((q) => artstationCount(q, signal).catch(() => 0)));
  const multi = (i: number) => part.tries[i].includes(' ');
  // a phrase over a single word: one word finds everything with that word in it
  let i = counts.findIndex((n, j) => n >= enough && multi(j));
  if (i < 0) i = counts.findIndex((n) => n >= enough);
  if (i < 0) i = counts.indexOf(Math.max(...counts));
  return { ...part, query: part.tries[i] };
}

/** One part's best pictures, best first: its own search, ranked by the picture model, only what clears the
 *  engine's relevance floor. The instant catalogs answer first, so it keeps reading until the web sources'
 *  pictures are ranked too (or time runs out); `extra` more than the board needs are kept as swaps. */
const SLOW_WAIT = 20000;
export async function searchPart(part: Part, signal: AbortSignal, like: Float32Array[] = [], waitMs = 9000): Promise<Hit[]> {
  // one page from each site (their best), and no figure check: a reference needn't be a readable pose.
  // `like` (the board's subject pictures) pulls the ranking toward them, as a 👍 would: "a wide-brimmed hat"
  // on this paladin ranks hats on armoured fantasy figures above a witch's
  const s = new Search({
    text: part.query,
    mode: part.mode === 'pose' && part.kind !== 'pose' ? 'concept' : part.mode,
    adult: false,
    off: offFor(part),
    pages: 1,
    prior: like.length ? { up: like, down: [] } : undefined,
  });
  const stop = () => s.abort();
  signal.addEventListener('abort', stop, { once: true });
  const t0 = performance.now(),
    until = t0 + waitMs;
  try {
    await s.next(10); // starts the sources and the ranking, and waits for the first good screen
    // then until the web's first pages are read: they hold most of the current work
    // (a slow device may have read nothing by then: it gets longer, rather than an empty part)
    // (catalog cards come already read, and rarely fit: it's the web's pictures that must be in)
    const webRead = () => s.ranked().filter((h) => !SOURCE_BY_ID[h.c.src]?.local).length;
    const late = () => performance.now() > (webRead() < part.n ? t0 + SLOW_WAIT : until);
    while (!late() && !signal.aborted && s.pending() > 0) {
      const web = webRead();
      if (web >= part.n + 8 && performance.now() - t0 > 2500) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const ranked = s.ranked();
    // no ranking model (it failed to load: an old phone, low memory): each site's own best, named ones first
    if (visionFailed() || !ranked.some((h) => !SOURCE_BY_ID[h.c.src]?.local))
      return [...ranked, ...s.found().filter((h) => h.state !== 'ranked' && !SOURCE_BY_ID[h.c.src]?.local && !h.c.adult && !ADULT_WORDS.test(`${h.c.title} ${h.c.tags.join(' ')}`))];
    return ranked;
  } finally {
    signal.removeEventListener('abort', stop);
    s.abort();
  }
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const NOT_ART =
  /\b(tool|tutorial|course|lesson|substance|blender|zbrush|maya|unreal|ue[45]|unity|marmoset|stl|3d print|printable|battle ?maps?|vtt|tokens?|\d+ ?x ?\d+|low ?poly|collection|photogrammetry|scans?|game[- ]ready|pbr|modular|kitbash|miniature|mesh|asset|pack|brush(es)?|preset|mockup|template|shader|material library|uv|topology|retopo|rig(ged)?|timelapse|speedpaint|wip|excerpt|chapter|page \d|poster|flyer|infographic|photoshop|procreate|font|logo|ui|hud|icons?)\b/i;
/** Paid reference compilations ("490+ Fantasy Wizard Outfit References"): a folder of other people's work. */
const PACK = /\b\d{2,}\s*\+|^\s*\d{2,}\s+\w|\breferences?\b|\bvol\.?\s*\d|\bbundle\b/i;
const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '').replace(/(ies|es|s)$/, '');
const GENERIC = new Set(['fantasy', 'concept', 'art', 'design', 'character', 'creature', 'portrait', 'pose', 'illustration', 'sheet', 'texture']);
/** How well a result fits its part. The picture model reads a two-word phrase only roughly (it's built from
 *  its words), so it sets a floor and breaks ties, while what the site itself says decides: its title naming
 *  the thing ("Half-Elf Rogue" for half-elf rogue) and the site's own order, best first. A catalog's cards
 *  come back by look alone, never by what they're of, so they must look clearly closer than the web's. */
export function fit(h: Hit, part: Part, best: number): number {
  const want = part.query.split(/[\s-]+/).map(stem).filter((w) => w.length > 2 && !GENERIC.has(w));
  const title = new Set(`${h.c.title} ${h.c.tags.join(' ')}`.split(/[^A-Za-z]+/).map(stem));
  const named = want.length ? want.filter((w) => title.has(w)).length / want.length : 0;
  // the pose library is photos of people in poses: for a pose it's the best there is, not a lookalike card
  // (the render section's one source is the point, not a lookalike: no catalog discount there)
  const local = !!SOURCE_BY_ID[h.c.src]?.local && !(part.kind === 'pose' && h.c.src === 'poses') && part.kind !== 'render';
  const order = local ? 0 : Math.max(0, 1 - h.c.pos / 30);
  const sim = h.sim ?? 0;
  // not a finished picture: software tutorials, printable models, brush and asset packs, 3D viewer posts
  const junk = NOT_ART.test(h.c.title) || PACK.test(h.c.title) || h.c.tags.includes('3d-post') ? 3 : 0;
  // current work first, among equals (the user wants what's being made now)
  const recent = h.c.year ? Math.max(0, Math.min(1, (h.c.year - 2018) / 7)) * 0.35 : 0;
  // an unread picture (no ranking model) has no look to judge: neither near nor far from the best
  const look = h.sim === undefined ? -0.3 : (sim - best) / 0.05;
  return look + 1.2 * named + 0.5 * order + recent - (local ? 0.6 : 0) - junk;
}

export const toPick = (h: Hit, part: Part): RefPick => ({
  key: h.c.key,
  src: h.c.src,
  title: h.c.title,
  thumb: h.c.thumb,
  full: h.c.full || h.c.thumb,
  page: h.c.page,
  artist: h.c.artist,
  part: part.id,
  label: part.label,
  q: part.query,
});

const MIN_FIT = -0.9;
/** Near-identical pictures (a reprint, the same splash cropped twice) above this look-alike. */
const SAME = 0.9;
/** At most this many pictures from one site on a board (ArtStation, where most current work is posted,
 *  excepted), and one per part: one game's art mustn't fill it. */
const PER_SOURCE = 2;

/** A catalog's two pictures of one champion or card name (two skins of Swain) read as the same picture. */
function sameSubject(h: Hit, board: RefPick[]): boolean {
  if (!SOURCE_BY_ID[h.c.src]?.local) return false;
  const names = (t: string) => t.split(/[^A-Za-z']+/).filter((w) => w.length >= 4 && /^[A-Z]/.test(w));
  const mine = new Set(names(h.c.title));
  return board.some((p) => p.src === h.c.src && names(p.title).some((w) => mine.has(w)));
}

/** A part's pictures: its quota of best-fitting results, none already on the board or a near copy of one,
 *  and the rest (up to 12) as swaps. `vecs` holds the board's picture vectors by key (it learns the new
 *  picks' too); `others` is everything else on the board. */
export function choose(part: Part, hits: Hit[], others: RefPick[], vecs: Map<string, Float32Array>, n = part.n): { picks: RefPick[]; spares: RefPick[] } {
  const best = Math.max(0, ...hits.map((h) => h.sim ?? 0));
  // below MIN_FIT a picture is neither named for the part nor close to its best match: better a smaller board
  const ranked = hits
    .map((h) => [h, fit(h, part, best)] as const)
    .filter(([, f]) => f >= MIN_FIT)
    .sort((a, b) => b[1] - a[1]);
  const perSrc = new Map<string, number>();
  others.forEach((o) => perSrc.set(o.src, (perSrc.get(o.src) ?? 0) + 1));
  const taken = new Set(others.map((o) => o.key));
  const near = (v: Float32Array | undefined, keys: Iterable<string>) => {
    if (!v) return false;
    for (const k of keys) {
      const u = vecs.get(k);
      if (u && dot(u, v) > SAME) return true;
    }
    return false;
  };
  const picks: RefPick[] = [],
    spares: RefPick[] = [];
  const mine: string[] = []; // this part's picks and swaps, so its swaps aren't copies of each other either
  // one source's two pictures with one title are the same work (a card's reprints, an artwork posted twice)
  const titled = new Set(others.map((o) => `${o.src}|${o.title.toLowerCase()}`));
  for (const [h] of ranked) {
    if (taken.has(h.c.key) || mine.includes(h.c.key) || near(h.vec, taken) || near(h.vec, mine)) continue;
    const tk = `${h.c.src}|${h.c.title.toLowerCase()}`;
    if (h.c.title && titled.has(tk)) continue;
    titled.add(tk);
    // (the render section is one source by design: the one-game rule doesn't apply to it)
    const full =
      h.c.src !== 'artstation' &&
      part.kind !== 'render' &&
      ((perSrc.get(h.c.src) ?? 0) >= PER_SOURCE || picks.some((p) => p.src === h.c.src) || sameSubject(h, others.concat(picks)));
    if (picks.length < n && !full) {
      picks.push(toPick(h, part));
      perSrc.set(h.c.src, (perSrc.get(h.c.src) ?? 0) + 1);
    } else if (spares.length < 12) spares.push(toPick(h, part));
    else continue;
    mine.push(h.c.key);
    if (h.vec) vecs.set(h.c.key, h.vec);
  }
  return { picks, spares };
}

/** A whole board at once (dev checks; the card fills its board part by part with choose()). */
export function assemble(parts: Part[], found: Map<string, Hit[]>): { picks: RefPick[]; spares: Map<string, RefPick[]> } {
  const vecs = new Map<string, Float32Array>(),
    picks: RefPick[] = [],
    spares = new Map<string, RefPick[]>();
  for (const part of parts) {
    const r = choose(part, found.get(part.id) ?? [], picks, vecs);
    picks.push(...r.picks);
    spares.set(part.id, r.spares);
  }
  return { picks: picks.slice(0, 10), spares };
}
