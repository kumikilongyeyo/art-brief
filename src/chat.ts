import { artText, hookLines } from './engine/lore';
import type { Brief } from './engine/types';

export const DEFAULT_STORY_INSTRUCTION = `You are a Dungeon Master and lore writer helping a fantasy concept artist.
Below is an art brief and a rough lore draft built from it.
Rewrite the lore as one vivid paragraph of 80–120 words, told the way a DM
would tell it at the table. Keep every visual element in the brief true and
keep the draft's beats (who made it, what it was for, what went wrong, where
it is now). You may add sensory detail and one memorable name or place.
Impossible or surreal materials are intentional: make them feel real.
Keep the Moment to paint as the climax and make it vivid enough to sketch
from. If a rumour, job or twist is included, fold them in lightly; the goal
is an image, not an adventure. Finish with 3 thumbnail ideas for that moment,
one short line each.

BRIEF:
{{brief}}

LORE DRAFT:
{{lore}}`;

function fill(template: string, brief: string): string {
  const tpl = template.includes('{{brief}}') ? template : `${template}\n\nBRIEF:\n{{brief}}`;
  return tpl.split('{{brief}}').join(brief);
}

/** Wrap one or more briefs in the ChatGPT instruction (spec section 8). */
export function chatText(briefs: Brief[], instruction: string, dnd = false): string {
  if (briefs.length === 1) return fill(instruction, artText(briefs[0], dnd));
  const n = briefs.length;
  const body = briefs.map((b, i) => `${i + 1}. ${artText(b, dnd)}`).join('\n\n');
  const intro = `There are ${n} briefs below. Handle each one separately and number your answers 1–${n}: one paragraph per brief, each followed by its own 3 thumbnail ideas.\n\n`;
  return intro + fill(instruction.replace('BRIEF:', 'BRIEFS:'), body);
}

/** Wrap a brief and its story in the story instruction ("Refine in ChatGPT" on the lore box). */
export function storyText(brief: Brief, instruction: string, dnd = false): string {
  let tpl = instruction;
  if (!tpl.includes('{{brief}}')) tpl += '\n\nBRIEF:\n{{brief}}';
  if (!tpl.includes('{{lore}}')) tpl += '\n\nLORE DRAFT:\n{{lore}}';
  const lore = brief.lore
    ? [
        brief.lore.text,
        ...(brief.lore.moment ? [`Moment to paint: ${brief.lore.moment}`] : []),
        ...(dnd ? ['', ...hookLines(brief.lore)] : []),
      ].join('\n')
    : '';
  return tpl.split('{{brief}}').join(artText(brief, dnd)).split('{{lore}}').join(lore);
}
