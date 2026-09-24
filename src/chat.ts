import type { Brief } from './engine/types';

function fill(template: string, brief: string): string {
  const tpl = template.includes('{{brief}}') ? template : `${template}\n\nBRIEF:\n{{brief}}`;
  return tpl.split('{{brief}}').join(brief);
}

/** Wrap one or more briefs in the ChatGPT instruction (spec section 8). */
export function chatText(briefs: Brief[], instruction: string): string {
  if (briefs.length === 1) return fill(instruction, briefs[0].plainText);
  const n = briefs.length;
  const body = briefs.map((b, i) => `${i + 1}. ${b.plainText}`).join('\n\n');
  const intro = `There are ${n} briefs below. Handle each one separately and number your answers 1–${n}: one paragraph per brief, each followed by its own 3 thumbnail ideas.\n\n`;
  return intro + fill(instruction.replace('BRIEF:', 'BRIEFS:'), body);
}
