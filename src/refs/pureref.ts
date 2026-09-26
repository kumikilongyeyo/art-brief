/** A brief's references as a PureRef board (.pur), built in the browser so the user can open it straight in PureRef.
 *
 *  PureRef has no published format. This writes the "1.10" layout that FyorDev/PureRef-format worked out
 *  (github.com/FyorDev/PureRef-format, purformat/write.py) and that PureRef 1.10 → 2.x all open. PureRef 2
 *  saves in a newer layout of its own (JPEG kept as-is, length-prefixed), but nobody has mapped that one, so
 *  we stay on the old one.
 *
 *  Everything is Qt's QDataStream: big-endian, doubles as IEEE 754, QString as a u32 byte length then
 *  UTF-16BE (0xFFFFFFFF = null string). The file is:
 *
 *    header (224 bytes)  version, item counts, where the reference table starts, an MD5, the view
 *    image data          each PNG back to back, no length prefix (the reference table says where each ends)
 *    items               one GraphicsImageItem per image, then one GraphicsTextItem per note
 *    folder              QString: the folder the board was saved from
 *    reference table     per image item: its id, start and end offset of its PNG
 *
 *  Pure data code: no DOM, so node tests run it. */

/** One picture on the board. `bytes` must be a PNG: the 1.10 layout stores nothing else, so re-encode
 *  JPEG/WebP first (OffscreenCanvas.convertToBlob({ type: 'image/png' })). */
export interface PurImage {
  bytes: Uint8Array;
  width: number; // pixels, as decoded
  height: number;
  x: number; // board position of the image's top-left corner
  y: number;
  scale?: number; // 1 = one board unit per pixel
  name?: string; // shown in PureRef's image info
  source?: string; // where it came from (a URL); PureRef only displays it
}

/** A text note. PureRef stores no text width, so line breaks must be in `text` (see wrapText).
 *  PureRef centres the text on its position (checked in PureRef 2.x), so x/y is the middle of the block;
 *  NOTE_CHAR and NOTE_LINE give its rough size for placing it. */
export interface PurNote {
  text: string;
  x: number; // centre of the text block on the board
  y: number;
  scale?: number; // 1 = PureRef's default text size
}

/** Roughly how big PureRef's default text is, in board units at scale 1 (measured in PureRef 2.x). */
export const NOTE_CHAR = 6.5; // average width of one character
export const NOTE_LINE = 17; // line height

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER = 224;

/** Grows as we append, and lets us go back and fill in offsets we only know later. */
class Out {
  buf = new Uint8Array(1 << 16);
  view = new DataView(this.buf.buffer);
  len = 0;

  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) { this.room(1); this.view.setUint8(this.len, v); this.len += 1; }
  u16(v: number) { this.room(2); this.view.setUint16(this.len, v); this.len += 2; }
  u32(v: number) { this.room(4); this.view.setUint32(this.len, v >>> 0); this.len += 4; }
  // Offsets past 4 GB can't happen in a browser download, so a u64 is a zero high word + u32.
  u64(v: number) { this.u32(Math.floor(v / 2 ** 32)); this.u32(v % 2 ** 32); }
  f64(v: number) { this.room(8); this.view.setFloat64(this.len, v); this.len += 8; }
  bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.len); this.len += b.length; }
  /** QString: byte length, then UTF-16BE code units (JS strings are UTF-16 already, surrogates and all). */
  str(s: string | null) {
    if (s === null) return this.u32(0xffffffff);
    this.u32(s.length * 2);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
  }
  /** A 2D transform as PureRef keeps it: [m11 m12 0 m21 m22 0]; we only ever scale, never rotate. */
  matrix(scale: number) { for (const v of [scale, 0, 0, 0, scale, 0]) this.f64(v); }
  /** QColor: spec (1 = RGB), alpha, r, g, b, pad; channels are 16-bit. */
  color(alpha: number, r: number, g: number, b: number) { this.u8(1); for (const v of [alpha, r, g, b, 0]) this.u16(v); }
  putU32(at: number, v: number) { this.view.setUint32(at, v >>> 0); }
  putU64(at: number, v: number) { this.putU32(at, Math.floor(v / 2 ** 32)); this.putU32(at + 4, v % 2 ** 32); }
  putF64(at: number, v: number) { this.view.setFloat64(at, v); }
  putStr(at: number, s: string) { for (let i = 0; i < s.length; i++) this.view.setUint16(at + i * 2, s.charCodeAt(i)); }
  done() { return this.buf.slice(0, this.len); }
}

/** Every item starts with where it ends (so a reader can skip types it doesn't know) and its class name. */
function begin(o: Out, type: string): number {
  const at = o.len;
  o.u64(0); // end offset, filled in by end()
  o.str(type);
  return at;
}
function end(o: Out, at: number) { o.putU64(at, o.len); }

export function encodePur(images: PurImage[], notes: PurNote[]): Uint8Array {
  for (const [i, im] of images.entries()) {
    if (!PNG_SIG.every((b, k) => im.bytes[k] === b)) throw new Error(`pureref: image ${i} is not a PNG`);
    if (!(im.width > 0 && im.height > 0)) throw new Error(`pureref: image ${i} has no size`);
  }
  if (images.length + notes.length > 0xffff) throw new Error('pureref: too many items'); // counts are u16

  const o = new Out();
  o.len = HEADER; // written last-but-one, once the counts and offsets are known

  // Image data. Each image item points back at its bytes through the reference table.
  const spans = images.map((im) => {
    const start = o.len;
    o.bytes(im.bytes);
    return [start, o.len];
  });

  // Ids: images first, then notes, as PureRef numbers them. Z follows the same order, so notes sit on top.
  let id = 0;
  for (const [i, im] of images.entries()) {
    const s = im.scale ?? 1;
    const w = im.width / 2, h = im.height / 2;
    const at = begin(o, 'GraphicsImageItem');
    o.str(im.source ?? null);
    o.str(im.name || `reference ${i + 1}`);
    o.f64(1); // unknown, always 1.0 (FyorDev's guess: opacity)
    o.matrix(s);
    // The picture is drawn centred on the item's origin, so its position is the centre.
    o.f64(im.x + w * s);
    o.f64(im.y + h * s);
    o.f64(1); // unknown, always 1.0
    o.u32(id++);
    o.f64(id); // z: 1, 2, 3… in board order
    // The uncropped state and the crop outline (a QPainterPath: move-to then four line-tos around the
    // whole picture). Leaving it the full rectangle means "not cropped".
    o.matrix(1);
    o.f64(-w);
    o.f64(-h);
    o.f64(1);
    const outline = [[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]];
    o.u32(outline.length);
    outline.forEach(([px, py], k) => { o.u32(k === 0 ? 0 : 1); o.f64(px); o.f64(py); });
    // Constant tail every saved image item has; the meaning isn't known.
    o.f64(0);
    o.u32(1);
    o.u8(0);
    o.u32(0xffffffff); o.u32(0xffffffff); // i64 -1
    o.u32(0); // text children
    end(o, at);
  }

  for (const n of notes) {
    const at = begin(o, 'GraphicsTextItem');
    o.str(n.text);
    o.matrix(n.scale ?? 1);
    o.f64(n.x);
    o.f64(n.y);
    o.f64(1); // unknown, always 1.0
    o.u32(id++);
    o.f64(id);
    o.color(0xffff, 0xffff, 0xffff, 0xffff); // white text…
    o.color(5000, 0, 0, 0); // …on PureRef's own faint black backing
    o.u32(0); // text children
    end(o, at);
  }

  // Saved-from folder. A download has none; empty is what a board that was never saved to disk carries.
  o.str('');
  const refs = o.len;
  for (const [i, [start, stop]] of spans.entries()) {
    o.u32(i); // image item id
    o.u64(start);
    o.u64(stop);
  }

  // Header, now the numbers are known.
  o.putU32(0, 8);
  o.putStr(4, '1.10'); // format version (PureRef 1.11 still writes 1.10)
  o.view.setUint16(12, images.length + notes.length); // top-level items
  o.view.setUint16(14, images.length); // of which images
  o.putU64(16, refs);
  o.putU32(24, 12);
  o.putStr(28, '1.11.1'); // QString: the PureRef version that saved it (FyorDev leaves it blank; their ImHex map calls it required)
  o.putU32(40, 64);
  o.putU32(108, id); // next free item id
  // Scene bounds (x, y, width, height), then the view as a QTransform (9 doubles: zoom 1, no pan).
  // PureRef opens a board fitted to its bounds, so they're the board's own (plus a margin): with the old
  // fixed ±10000 square the board opened as a speck in the square's corner.
  const box = bounds(images, notes);
  [box.x, box.y, box.w, box.h].forEach((v, k) => o.putF64(112 + k * 8, v));
  o.putF64(144, 1); // m11
  o.putF64(176, 1); // m22
  o.putF64(208, 1); // m33
  // 216..224: view centre (two i32), left at 0,0.

  // PureRef refuses a file whose checksum is off: MD5 of everything after it, as 32 hex chars in UTF-16.
  o.putStr(44, md5Hex(o.buf.subarray(108, o.len)));
  return o.done();
}

/** Everything on the board, as x, y, width, height, with a margin. */
function bounds(images: PurImage[], notes: PurNote[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx); y1 = Math.max(y1, by);
  };
  for (const im of images) add(im.x, im.y, im.x + im.width * (im.scale ?? 1), im.y + im.height * (im.scale ?? 1));
  for (const n of notes) {
    const lines = n.text.split('\n'), s = n.scale ?? 1;
    const w = (Math.max(...lines.map((l) => l.length)) * NOTE_CHAR * s) / 2, h = (lines.length * NOTE_LINE * s) / 2;
    add(n.x - w, n.y - h, n.x + w, n.y + h);
  }
  if (!Number.isFinite(x0)) return { x: -10000, y: -10000, w: 20000, h: 20000 };
  const m = Math.max(100, 0.03 * Math.max(x1 - x0, y1 - y0));
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

/** Hard-wrap a note at `cols` characters, since PureRef text items don't wrap by themselves. */
export function wrapText(text: string, cols = 48): string {
  return text
    .split('\n')
    .map((para) => {
      const lines: string[] = [];
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + word.length > cols) { lines.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
      return lines.join('\n');
    })
    .join('\n');
}

/** Lay pictures out in rows, each scaled to the same height, wrapping at `maxWidth` board units.
 *  Returns positions to spread into PurImage; `bottom` is the y just below the last row, where a note can
 *  go (its y is its centre: bottom + lines * NOTE_LINE * scale / 2), and `width` the widest row. */
export function layoutBoard(
  sizes: { width: number; height: number }[],
  { rowHeight = 600, maxWidth = 3000, gap = 20 } = {},
): { placed: { x: number; y: number; scale: number }[]; bottom: number; width: number } {
  const placed: { x: number; y: number; scale: number }[] = [];
  let x = 0, y = 0, width = 0;
  for (const s of sizes) {
    const scale = rowHeight / s.height;
    const w = s.width * scale;
    if (x > 0 && x + w > maxWidth) { x = 0; y += rowHeight + gap; }
    placed.push({ x, y, scale });
    width = Math.max(width, x + w);
    x += w + gap;
  }
  return { placed, bottom: sizes.length ? y + rowHeight + gap : 0, width };
}

// MD5 (RFC 1321). WebCrypto has no MD5, and this is the only hash the format uses.
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

export function md5Hex(data: Uint8Array): string {
  const n = data.length;
  const padded = new Uint8Array((((n + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (n * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(n / 2 ** 29), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) m[j] = dv.getUint32(off + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + m[g]) >>> 0;
      const r = R[(i >> 4) * 4 + (i & 3)];
      b = (b + ((sum << r) | (sum >>> (32 - r)))) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let hex = '';
  for (const v of [a0, b0, c0, d0]) for (let k = 0; k < 4; k++) hex += ((v >>> (k * 8)) & 0xff).toString(16).padStart(2, '0');
  return hex;
}
