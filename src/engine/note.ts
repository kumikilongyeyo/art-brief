import { capitalise, withArticle } from './grammar';
import { withThe } from './lore';
import type { Brief } from './types';

/** "a scale hauberk" but "ceremonial vestments", "a skirt and bracers" (plural heads take no article). */
function garment(text: string): string {
  const head = text.split(' of ')[0];
  const last = head.split(/\s+/).pop() ?? '';
  const plural = / and /.test(head) || (/s$/.test(last) && !/(ss|us)$/.test(last));
  return plural ? text : withArticle(text);
}

/**
 * The card's plain-language summary ("read it like a note"): two or three sentences built from the
 * brief's own lines, so it always matches the details. Lines trimmed by the word budget are skipped.
 */
export function summaryNote(brief: Brief): string {
  const line = (label: string) => brief.lines.find((l) => l.label === label)?.text ?? '';
  const [name, desc = ''] = brief.title.split(' — ');
  const sentence = (s: string) => capitalise(s.trim()).replace(/[.\s]*$/, '.');
  const parts: string[] = [];
  switch (brief.category) {
    case 'character': {
      parts.push(`${name} is ${withArticle(desc)}: ${line('Look')}`);
      const wearing = line('Wearing');
      const pose = line('Pose');
      if (wearing) parts.push(`Wearing ${garment(wearing)}${pose ? `, shown ${pose}` : ''}`);
      break;
    }
    case 'prop': {
      const origin = line('Origin');
      parts.push(`${name} is ${withArticle(desc)}${origin ? ` from ${withThe(origin)}` : ''}`);
      const fn = line('Function');
      if (fn) parts.push(`It ${fn}`);
      break;
    }
    case 'creature': {
      const [type, body] = desc.split(', ');
      const habitat = line('Habitat');
      parts.push(`${name} is ${withArticle(type)}${body ? `, ${withArticle(body)},` : ''}${habitat ? ` from ${withThe(habitat)}` : ''}`);
      const adaptation = line('Adaptation');
      const behaviour = line('Behaviour');
      if (adaptation) parts.push(`It has ${adaptation}${behaviour ? ` and ${behaviour}` : ''}`);
      const scale = line('Scale');
      if (scale) parts.push(`It is ${scale}`);
      break;
    }
    case 'building': {
      const [fn, style = ''] = desc.split(', ');
      const material = line('Built of');
      parts.push(`${name} is ${withArticle(fn)} in the ${style.replace(/ style$/, '')} style${material ? `, built of ${material}` : ''}`);
      const feature = line('Signature feature');
      if (feature) parts.push(`Its signature feature: ${feature}`);
      break;
    }
    case 'scene': {
      const location = line('Location');
      const time = line('Time & weather');
      parts.push(`${name}: ${location}${time ? `, ${time}` : ''}`);
      const event = line('Event');
      if (event) parts.push(event);
      const mood = line('Mood');
      if (mood) parts.push(`The mood: ${mood}`);
      break;
    }
  }
  return parts.map(sentence).join(' ');
}
