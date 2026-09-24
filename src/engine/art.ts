import { pickEntry, type PickContext } from './pick';
import { rngFrom, type Rng } from './rng';
import type { CategoryDef, DataSet, Entry, SlotId, Theme } from './types';

/**
 * Art direction for a card — the studio job and how to draw it, derived from the card's own lines.
 * A purpose (TCG card art, 3D turnaround, cover…) is rolled first and decides the camera and
 * deliverables; hard requires/excludes on the art tables keep the direction from contradicting
 * the subject (no skeleton pass for an ooze, no "no straight lines" for a rapier).
 * Deterministic per seed + fields + art reroll.
 */

export interface ArtDirection {
  /** Studio purpose label, e.g. "TCG card art". */
  purpose?: string;
  /** One-line assignment: "Card art of Raskogar Stonehammer for a trading-card game". */
  ask?: string;
  shape: string;
  focal: string;
  light: string;
  camera?: string;
  /** What to hand in, with a suggested time. */
  deliverable?: string;
  /** One line of art-director feedback. */
  note?: string;
}

interface ArtField {
  entryId: string;
  text: string;
  tags: string[];
  label?: string;
}

/** The noun-phrase line each category's focal point comes from. */
const FOCAL_SLOT: Record<string, SlotId> = {
  character: 'look',
  prop: 'details',
  creature: 'adaptation',
  building: 'feature',
  scene: 'event',
};
/** What the focal point plays against. */
const COUNTER_SLOT: Record<string, SlotId> = {
  character: 'outfit',
  prop: 'material',
  creature: 'habitat',
  building: 'material',
  scene: 'location',
};

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** True when the palette has a clearly warm, reasonably saturated colour (reds through yellows). */
export function hasWarm(hex: string[]): boolean {
  return hex.some((h) => {
    const n = parseInt(h.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 0.25 || max < 0.35) return false;
    let hue: number;
    if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue = (hue * 60 + 360) % 360;
    return hue <= 60 || hue >= 330;
  });
}

/** Low-key / high-key / full-range plan from the palette's actual values. */
export function valuePlan(hex: string[]): string {
  if (!hex.length) return '';
  const sorted = [...hex].sort((a, b) => luminance(a) - luminance(b));
  const dark = sorted[0].toUpperCase();
  const light = sorted[sorted.length - 1].toUpperCase();
  const ls = hex.map(luminance);
  const darks = ls.filter((l) => l < 0.08).length / ls.length;
  const lights = ls.filter((l) => l > 0.45).length / ls.length;
  if (darks >= 0.5) return `low-key: keep most of the image dark and save ${light} for the focal point`;
  if (lights >= 0.5) return `high-key: mostly light values, with ${dark} only for accents and edges`;
  return `full range from ${dark} to ${light}; let the mid-tones carry the form`;
}

function shorten(text: string, max = 10): string {
  const clean = text.replace(/\s*\{m\}/, '');
  const words = clean.split(/\s+/);
  return words.length <= max ? clean : `${words.slice(0, max).join(' ')}…`;
}

/** Scene focal point: the event's first actor ("the hag"); counterpoint: the second actor or the location. */
function sceneActors(data: DataSet, fields: Record<SlotId, ArtField>): [string, string] | null {
  const [, a, b] = (fields.event?.entryId ?? '').split('~');
  const actors = data.tables['scene.actors']?.entries ?? [];
  const find = (id?: string) => actors.find((x) => x.id === id)?.text;
  const fa = find(a);
  if (!fa) return null;
  const fb = find(b);
  const loc = fields.location?.text;
  return [`the ${fa}`, fb ? `the ${fb}` : loc ? `the ${shorten(loc, 6)}` : 'the background'];
}

function pickFrom(entries: Entry[], ctx: PickContext, rng: Rng): Entry | undefined {
  return entries.length ? pickEntry(entries, ctx, rng).entry : undefined;
}

export function makeArt(
  data: DataSet,
  cat: CategoryDef,
  theme: Theme,
  seed: string,
  fields: Record<SlotId, ArtField>,
  paletteHex: string[],
  artRoll: number,
): ArtDirection {
  const tags = new Set<string>(cat.baseTags);
  for (const s of cat.slots) fields[s.id]?.tags.forEach((t) => tags.add(t));
  const ctx: PickContext = { theme, weirdness: 'grounded', tags, excludes: new Set(), applyBlock: false, affinity: 3 };
  // Fixed slot order: field objects can be built in different orders (share links pin everything).
  const key = cat.slots.map((s) => fields[s.id]?.entryId ?? '').join('|');
  const rng = rngFrom(`${seed}-art-${artRoll}-${key}`);
  const table = (id: string) => data.tables[id]?.entries ?? [];
  const name = (fields.name?.text ?? 'it').replace(/^The /, 'the ');

  // 1. The job. Its camera and deliverables come only from lines written for that purpose.
  const purpose = pickFrom(table('shared.art-purpose'), ctx, rng);
  const forPurpose = (id: string) => {
    const all = table(id);
    if (!purpose) return all;
    const own = all.filter((e) => e.purposes?.includes(purpose.id));
    return own.length ? own : all;
  };

  // 2. Focal point as a design hook: the striking line, played against a counterpoint from the card.
  const scene = cat.id === 'scene' ? sceneActors(data, fields) : null;
  const focalText = scene ? scene[0] : shorten(fields[FOCAL_SLOT[cat.id]]?.text ?? 'the subject');
  const counterText = scene
    ? scene[1]
    : `the ${shorten(fields[COUNTER_SLOT[cat.id]]?.text ?? 'background', 6)}`.replace(/^the (the|a|an) /, 'the ');
  const warm = hasWarm(paletteHex);
  const hooks = table('shared.art-hook').filter((e) => warm || !e.tags?.includes('warm'));
  const hook = pickFrom(hooks, { ...ctx, tags: new Set(), affinity: undefined }, rng)?.text ?? 'Lead with {focal}';
  const focal = hook.replace('{focal}', focalText).replace('{counter}', counterText);

  // 3. Light: buildings and scenes already carry a Light / Time line, so they get the value plan only.
  const plan = valuePlan(paletteHex);
  const setup = cat.id === 'building' || cat.id === 'scene' ? '' : (pickFrom(table('shared.art-light'), ctx, rng)?.text ?? '');
  const light = setup ? `${setup}; ${plan}` : plan;

  const art: ArtDirection = { shape: pickFrom(table('shared.art-shape'), ctx, rng)?.text ?? '', focal, light };
  if (purpose) {
    art.purpose = purpose.label ?? purpose.text;
    art.ask = purpose.text.replace('{name}', name);
  }
  const cam = pickFrom(forPurpose('shared.art-camera'), ctx, rng)?.text;
  if (cam) art.camera = cam;
  const deliverable = pickFrom(forPurpose('shared.art-deliverable'), ctx, rng)?.text;
  if (deliverable) art.deliverable = deliverable;
  // Notes: general ones plus those written for this purpose.
  const notes = table('shared.art-note').filter((e) => !e.purposes || (purpose && e.purposes.includes(purpose.id)));
  const note = pickFrom(notes, ctx, rng)?.text;
  if (note) art.note = note;
  return art;
}

export function artLines(art: ArtDirection, category: string): string[] {
  const out: string[] = [];
  if (art.ask) out.push(`The ask: ${art.ask}.`);
  out.push(
    `Shape: ${art.shape}`,
    `Focal point: ${art.focal}.`,
    `${category === 'building' || category === 'scene' ? 'Value' : 'Light & value'}: ${art.light}`,
  );
  if (art.camera) out.push(`Camera: ${art.camera}`);
  if (art.deliverable) out.push(`Deliverables: ${art.deliverable}`);
  if (art.note) out.push(`AD note: ${art.note}.`);
  return out;
}
