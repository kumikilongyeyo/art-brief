import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodePur, layoutBoard, md5Hex, wrapText, type PurImage } from '../../src/refs/pureref';

// Not a real picture: the encoder only checks the PNG signature, and the bytes go in untouched.
const fakePng = (tag: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag, tag]);
const img = (tag: number, x = 0, y = 0): PurImage => ({ bytes: fakePng(tag), width: 40, height: 30, x, y, scale: 2, name: `n${tag}` });
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at);
const utf16 = (b: Uint8Array, at: number, bytes: number) => String.fromCharCode(...Array.from({ length: bytes / 2 }, (_, i) => u16(b, at + i * 2)));

describe('PureRef board', () => {
  const pur = encodePur([img(1), img(2, 100), img(3, 0, 100)], [{ text: 'Brief — «note»', x: 50, y: -40 }]);

  it('writes the 1.10 header', () => {
    expect(u32(pur, 0)).toBe(8);
    expect(utf16(pur, 4, 8)).toBe('1.10');
    expect(u32(pur, 24)).toBe(12);
    expect(utf16(pur, 28, 12)).toBe('1.11.1');
    expect(u32(pur, 40)).toBe(64);
  });

  it('counts images and notes', () => {
    expect(u16(pur, 12)).toBe(4); // all top-level items
    expect(u16(pur, 14)).toBe(3); // images
    expect(u32(pur, 108)).toBe(4); // next free id
  });

  it('checksums everything after the checksum', () => {
    expect(utf16(pur, 44, 64)).toBe(createHash('md5').update(pur.subarray(108)).digest('hex'));
  });

  it('stores each PNG after the header and indexes it in the reference table', () => {
    const refs = u32(pur, 20); // u64 high word is 0 for anything a browser writes
    expect(u32(pur, 16)).toBe(0);
    expect(pur.length).toBe(refs + 3 * 20);
    for (let i = 0; i < 3; i++) {
      const row = refs + i * 20;
      expect(u32(pur, row)).toBe(i);
      const start = u32(pur, row + 8), end = u32(pur, row + 16);
      expect(Array.from(pur.subarray(start, end))).toEqual(Array.from(fakePng(i + 1)));
    }
    expect(u32(pur, refs + 8)).toBe(224);
  });

  it('writes one item per image and note', () => {
    const find = (s: string) => {
      let n = 0;
      for (let at = 0; at + s.length * 2 <= pur.length; at++) if (utf16(pur, at, s.length * 2) === s) n++;
      return n;
    };
    expect(find('GraphicsImageItem')).toBe(3);
    expect(find('GraphicsTextItem')).toBe(1);
    expect(find('Brief — «note»')).toBe(1);
  });

  it('refuses anything but PNG', () => {
    expect(() => encodePur([{ ...img(1), bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }], [])).toThrow(/not a PNG/);
  });

  it('encodes an empty board', () => {
    const empty = encodePur([], []);
    expect(u16(empty, 12)).toBe(0);
    expect(empty.length).toBe(224 + 4); // header + empty folder string
  });
});

describe('helpers', () => {
  it('md5 matches node', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);
      expect(md5Hex(b)).toBe(createHash('md5').update(b).digest('hex'));
    }
  });

  it('wraps text at word boundaries and keeps paragraphs', () => {
    expect(wrapText('one two three four', 9)).toBe('one two\nthree\nfour');
    expect(wrapText('a\nb c', 10)).toBe('a\nb c');
  });

  it('lays rows at one height and wraps', () => {
    const { placed, bottom, width } = layoutBoard([{ width: 300, height: 300 }, { width: 600, height: 300 }, { width: 300, height: 600 }], { rowHeight: 100, maxWidth: 300, gap: 10 });
    // The wide one doesn't fit after the first, so it starts row two; the narrow tall one fits beside it.
    expect(placed).toEqual([{ x: 0, y: 0, scale: 1 / 3 }, { x: 0, y: 110, scale: 1 / 3 }, { x: 210, y: 110, scale: 1 / 6 }]);
    expect(bottom).toBe(220);
    expect(width).toBe(260);
  });
});
