/** A brief's reference board as a PureRef file: the brief as a note on top, the subject pictures large
 *  underneath, then the parts' pictures in rows, each named for what it shows and where it's from. */
import { summaryNote } from '../engine/note';
import type { Brief, RefPick } from '../engine/types';
import { toast } from '../ui/toast';
import { RELAY } from './net';
import { encodePur, layoutBoard, NOTE_LINE, wrapText, type PurImage, type PurNote } from './pureref';

const LONG_SIDE = 1280; // pictures are scaled down to this: PNG only, so a board of ten stays under ~10 MB
const PAD = 40;

/** The picture as a PNG the page may read: straight from hosts that allow it, else through wsrv.nl (which
 *  converts it too), else our relay. */
async function pngOf(p: RefPick): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
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

export async function exportPur(brief: Brief, picks: RefPick[]): Promise<void> {
  toast('Making the PureRef board…');
  const got = await Promise.all(picks.map(async (p) => ({ p, img: await pngOf(p) })));
  const ok = got.filter((g): g is { p: RefPick; img: NonNullable<typeof g.img> } => !!g.img);
  if (!ok.length) throw new Error('no picture could be read');

  const name = brief.fields.name?.text ?? brief.title;
  const note = wrapText(`${name}\n${brief.title}\n\n${summaryNote(brief)}\n\nPalette: ${brief.palette.name} · ${brief.palette.hex.join(' ')}`, 64);
  const noteScale = 2.2;
  const noteLines = note.split('\n').length;
  const noteH = noteLines * NOTE_LINE * noteScale;

  // the subject large, then everything else in rows under it, as wide as the subject row
  const subject = ok.filter((g) => g.p.part === 'subject');
  const rest = ok.filter((g) => g.p.part !== 'subject');
  const top = layoutBoard(
    subject.map((g) => g.img),
    { rowHeight: 900, maxWidth: 4000, gap: PAD },
  );
  const width = Math.max(top.width, 2400);
  const below = layoutBoard(
    rest.map((g) => g.img),
    { rowHeight: 520, maxWidth: width, gap: PAD },
  );
  const y0 = noteH + PAD * 2;
  const images: PurImage[] = [
    ...subject.map((g, i) => ({ ...g.img, ...top.placed[i], y: y0 + top.placed[i].y, name: `${g.p.label} — ${g.p.title}`, source: g.p.page })),
    ...rest.map((g, i) => ({
      ...g.img,
      ...below.placed[i],
      y: y0 + top.bottom + below.placed[i].y,
      name: `${g.p.label} — ${g.p.title}`,
      source: g.p.page,
    })),
  ];
  const longest = Math.max(...note.split('\n').map((l) => l.length));
  const notes: PurNote[] = [{ text: note, x: (longest * 6.5 * noteScale) / 2, y: noteH / 2, scale: noteScale }];

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
  const missed = picks.length - ok.length;
  toast(missed ? `Downloaded ${file} (${missed} picture${missed > 1 ? 's' : ''} couldn’t be fetched)` : `Downloaded ${file}`);
}
