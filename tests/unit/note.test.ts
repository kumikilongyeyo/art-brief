import { describe, expect, it } from 'vitest';
import { findArticleErrors } from '../../src/engine/grammar';
import { summaryNote } from '../../src/engine/note';
import { WEIRDNESS } from '../../src/engine/types';
import { CATS, one, seeds } from './helpers';

describe('summary note (read it like a note)', () => {
  it('reads cleanly for every category: names the subject, no article slips, no leftover braces, short', () => {
    const problems: string[] = [];
    let longest = 0;
    for (const c of CATS)
      for (const w of WEIRDNESS)
        for (const base of seeds(60, `note-${c}-${w}`)) {
          const b = one(c, base, { weirdness: w });
          const note = summaryNote(b);
          const words = note.split(/\s+/).length;
          longest = Math.max(longest, words);
          const name = b.title.split(' — ')[0];
          if (!note.startsWith(name)) problems.push(`no name: ${note}`);
          if (/[{}]|undefined|\s\./.test(note)) problems.push(`junk: ${note}`);
          if (!/\.$/.test(note)) problems.push(`unterminated: ${note}`);
          for (const e of findArticleErrors(note)) problems.push(`${e}: ${note}`);
        }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(longest).toBeLessThanOrEqual(60);
  });

  it('only uses words that are on the card', () => {
    const b = one('character', 'NOTE01');
    const wearing = b.lines.find((l) => l.label === 'Wearing')?.text;
    if (wearing) expect(summaryNote(b)).toContain(wearing);
  });
});
