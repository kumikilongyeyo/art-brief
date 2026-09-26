/** A brief's reference board as a PureRef file, laid out like the brief: its name and summary on top, the
 *  palette as colour swatches (a picture, not text), then one labelled section per part of the brief
 *  (Subject, Look, Wearing…) with 3–5 pictures each, every picture captioned with what it is and where
 *  it's from. */
import { summaryNote } from '../engine/note';
import type { Brief, RefPick } from '../engine/types';
import { toast } from '../ui/toast';
import { RELAY } from './net';
import { encodePur, NOTE_CHAR, NOTE_LINE, wrapText, type PurImage, type PurNote } from './pureref';
import { SOURCE_BY_ID } from './sources';
import type { SourceId } from './types';

const LONG_SIDE = 800; // pictures are scaled down to this (they sit ~520 units tall): PNG only, so ~15–20 MB
const ROW_H = 520; // every section's pictures share one height
const GAP = 40;
const PER_PART = 5; // the board's pictures of a part, topped up with its swaps (3–5 once searched)
const WIDTH = 3000; // a section wider than this wraps

type Png = { bytes: Uint8Array; width: number; height: number };

/** The picture as a PNG the page may read: straight from hosts that allow it, else through wsrv.nl (which
 *  converts it too), else our relay. */
async function pngOf(p: RefPick): Promise<Png | null> {
  const bare = (u: string) => u.replace(/^https?:\/\//, '');
  const urls = [
    p.full,
    p.src === 'artstation' ? p.thumb.replace('/smaller_square/', '/small_square/') : '',
    `https://wsrv.nl/?url=${encodeURIComponent(bare(p.full))}&w=${LONG_SIDE}&h=${LONG_SIDE}&fit=inside&output=png`,
    `https://wsrv.nl/?url=${encodeURIComponent(bare(p.thumb))}&output=png`,
    RELAY ? `${RELAY}/img?u=${encodeURIComponent(p.thumb)}` : '',
  ].filter((u, i, a) => u && a.indexOf(u) === i);
  for (const url of urls) {
    try {
      const r = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!r.ok) continue;
      const blob = await r.blob();
      if (!blob.type.startsWith('image/')) continue;
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
      const width = Math.round(bmp.width * k),
        height = Math.round(bmp.height * k);
      let png: Blob = blob;
      // the file format stores PNG only: anything else (or anything too big) is redrawn
      if (blob.type !== 'image/png' || k < 1) {
        const c = new OffscreenCanvas(width, height);
        c.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
        png = await c.convertToBlob({ type: 'image/png' });
      }
      bmp.close();
      return { bytes: new Uint8Array(await png.arrayBuffer()), width, height };
    } catch {
      // not readable from here (no CORS header, blocked, gone): the next way
    }
  }
  return null;
}

/** The palette as one picture: a swatch per colour, each with its hex under it. */
async function paletteImage(hex: string[]): Promise<Png> {
  const S = 220,
    PAD = 16,
    LABEL = 46;
  const c = new OffscreenCanvas(hex.length * (S + PAD) - PAD, S + LABEL);
  const x = c.getContext('2d')!;
  hex.forEach((h, i) => {
    const left = i * (S + PAD);
    x.fillStyle = h;
    x.fillRect(left, 0, S, S);
    x.fillStyle = '#f2f2f2';
    x.font = '600 28px ui-monospace, Menlo, monospace';
    x.textAlign = 'center';
    x.fillText(h.toUpperCase(), left + S / 2, S + 34);
  });
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
}

/** A note whose top-left corner is at (x, y) (PureRef places notes by their centre). */
function note(text: string, x: number, y: number, scale: number): { note: PurNote; h: number; w: number } {
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => l.length)) * NOTE_CHAR * scale,
    h = lines.length * NOTE_LINE * scale;
  return { note: { text, x: x + w / 2, y: y + h / 2, scale }, h, w };
}

const sourceName = (src: string) => SOURCE_BY_ID[src as SourceId]?.label ?? src;

export async function exportPur(brief: Brief, picks: RefPick[], spares: RefPick[] = []): Promise<void> {
  toast('Making the PureRef board…');
  // each part's pictures in board order, topped up with its best swaps to 3–5
  const order: string[] = [];
  const byPart = new Map<string, RefPick[]>();
  for (const p of picks) {
    if (!byPart.has(p.part)) {
      order.push(p.part);
      byPart.set(p.part, []);
    }
    byPart.get(p.part)!.push(p);
  }
  // …never a picture another section already shows (a swap can be another part's pick)
  const seen = new Set(picks.map((p) => p.key));
  for (const s of spares) {
    const list = byPart.get(s.part);
    if (list && list.length < PER_PART && !seen.has(s.key)) {
      list.push(s);
      seen.add(s.key);
    }
  }
  const all = order.flatMap((id) => byPart.get(id)!);
  const pngs = new Map<string, Png | null>();
  await Promise.all(all.map(async (p) => pngs.set(p.key, await pngOf(p))));
  const read = all.filter((p) => pngs.get(p.key));
  if (!read.length) throw new Error('no picture could be read');

  const images: PurImage[] = [];
  const notes: PurNote[] = [];
  let y = 0;

  // the brief: name, what it is, the summary
  const name = brief.fields.name?.text ?? brief.title;
  const title = note(name, 0, y, 5);
  notes.push(title.note);
  y += title.h + 10;
  const sub = note(brief.title, 0, y, 2.4);
  notes.push(sub.note);
  y += sub.h + GAP / 2;
  const body = note(wrapText(summaryNote(brief), 90), 0, y, 2.2);
  notes.push(body.note);
  y += body.h + GAP;

  // the palette, as colours
  const pal = await paletteImage(brief.palette.hex);
  const palLabel = note(`PALETTE · ${brief.palette.name}`, 0, y, 2.4);
  notes.push(palLabel.note);
  y += palLabel.h + 12;
  images.push({ ...pal, x: 0, y, scale: 1, name: `Palette — ${brief.palette.name}` });
  y += pal.height + GAP * 2;

  // one section per part: a heading, then its pictures in a row, each with a caption under it
  for (const id of order) {
    const list = byPart.get(id)!.filter((p) => pngs.get(p.key));
    if (!list.length) continue;
    const head = note(`${list[0].label.toUpperCase()} · ${list[0].q}`, 0, y, 3);
    notes.push(head.note);
    y += head.h + 16;
    let x = 0,
      rowTop = y;
    for (const p of list) {
      const img = pngs.get(p.key)!;
      const scale = ROW_H / img.height,
        w = img.width * scale;
      if (x > 0 && x + w > WIDTH) {
        x = 0;
        rowTop += ROW_H + 110;
      }
      images.push({ ...img, x, y: rowTop, scale, name: `${p.label} — ${p.title}`, source: p.page });
      const cols = Math.max(12, Math.floor(w / (NOTE_CHAR * 1.6)));
      const cap = note(wrapText(`${p.title || 'Untitled'}\n${[p.artist, sourceName(p.src)].filter(Boolean).join(' · ')}`, cols).split('\n').slice(0, 3).join('\n'), x, rowTop + ROW_H + 10, 1.6);
      notes.push(cap.note);
      x += w + GAP;
    }
    y = rowTop + ROW_H + 110 + GAP;
  }

  const bytes = encodePur(images, notes);
  const file = `${name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'references'}.pur`;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const missed = all.length - read.length;
  toast(missed ? `Downloaded ${file} (${missed} picture${missed > 1 ? 's' : ''} couldn’t be fetched)` : `Downloaded ${file}`);
}
