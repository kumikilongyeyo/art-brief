import { pickEntry, type PickContext } from './pick';
import { rngFrom } from './rng';
import type { CategoryDef, DataSet, Entry, SlotId, Theme } from './types';

/**
 * Art direction for a card — how to draw it, derived from its own lines:
 * shape language, focal point, light & value, camera. Deterministic per seed + fields + art reroll.
 */

export interface ArtDirection {
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
}

/** The line each category's focal point defaults to when there's no (visual) unique trait. */
const FOCAL_SLOT: Record<string, [SlotId, string]> = {
  character: ['look', 'Look'],
  prop: ['details', 'Details'],
  creature: ['adaptation', 'Adaptation'],
  building: ['feature', 'Signature feature'],
  scene: ['event', 'Event'],
};
const FOCAL_HOW = [
  'sharpest edges and highest contrast here',
  'brightest value and most saturated colour here',
  'the only warm spot in the image',
  'most detail here; keep everything else simple',
  'everything else leads the eye to it',
];
const NONVISUAL = /\b(smells?|scent|hums?|sings?|whispers?|voice|echo|sound|silent|tastes?|to the touch|feels?)\b/;

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
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

function shorten(text: string): string {
  const words = text.split(/\s+/);
  return words.length <= 12 ? text : `${words.slice(0, 12).join(' ')}…`;
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
  for (const f of Object.values(fields)) f?.tags.forEach((t) => tags.add(t));
  const ctx: PickContext = { theme, weirdness: 'grounded', tags, excludes: new Set(), applyBlock: false, affinity: 3 };
  // Fixed slot order: field objects can be built in different orders (share links pin everything).
  const key = cat.slots.map((s) => fields[s.id]?.entryId ?? '').join('|');
  const rng = rngFrom(`${seed}-art-${artRoll}-${key}`);
  const from = (id: string): Entry | undefined => {
    const entries = data.tables[id]?.entries ?? [];
    return entries.length ? pickEntry(entries, ctx, rng).entry : undefined;
  };

  // Focal point: a visual unique trait wins most of the time, else the category's most striking line.
  const [slot, label] = FOCAL_SLOT[cat.id];
  const uniq = fields.unique;
  const useUnique = uniq && uniq.entryId !== 'none' && !NONVISUAL.test(uniq.text) && rng() < 0.6;
  const focalText = useUnique ? uniq.text : (fields[slot]?.text ?? '');
  const focal = `${shorten(focalText)} (${useUnique ? 'Unique' : label}) — ${FOCAL_HOW[Math.floor(rng() * FOCAL_HOW.length)]}`;

  // Buildings and scenes already carry a Light / Time line, so they get the value plan only.
  const plan = valuePlan(paletteHex);
  const setup = cat.id === 'building' || cat.id === 'scene' ? '' : (from('shared.art-light')?.text ?? '');
  const light = setup ? `${setup}; ${plan}` : plan;

  const art: ArtDirection = { shape: from('shared.art-shape')?.text ?? '', focal, light };
  // Scenes have a Composition line already; everything else gets a camera note.
  if (cat.id !== 'scene') {
    const cam = from('shared.art-camera')?.text;
    if (cam) art.camera = cam;
  }
  const deliverable = from('shared.art-deliverable')?.text;
  if (deliverable) art.deliverable = deliverable;
  const note = from('shared.art-note')?.text;
  if (note) art.note = note;
  return art;
}

export function artLines(art: ArtDirection, category: string): string[] {
  const out = [
    `Shape: ${art.shape}`,
    `Focal point: ${art.focal}`,
    `${category === 'building' || category === 'scene' ? 'Value' : 'Light & value'}: ${art.light}`,
  ];
  if (art.camera) out.push(`Camera: ${art.camera}`);
  if (art.deliverable) out.push(`Deliverables: ${art.deliverable}`);
  if (art.note) out.push(`AD note: ${art.note}.`);
  return out;
}
