// Words that start with a vowel letter but a consonant sound, and vice versa.
const CONSONANT_SOUND =
  /^(uni(?!mpress|nform|nhabit|ntell|nvit|dent|mag|nsur|mport|llum)|use|usu|eu|ewe|one\b|one-|once|ouija|u[bcfgklrstvz][aeiou])/i;
const VOWEL_SOUND = /^(hour|honest|honou?r|heir|herb\b|x-|mri|fbi|nbc)/i;

export function startsWithVowelSound(word: string): boolean {
  const w = word.toLowerCase().replace(/^[^a-z0-9]+/, '');
  if (!w) return false;
  if (VOWEL_SOUND.test(w)) return true;
  if (/^[aeiou]/.test(w)) return !CONSONANT_SOUND.test(w);
  if (/^[0-9]/.test(w)) return /^(8|11|18)/.test(w);
  return false;
}

export function article(phrase: string): string {
  return startsWithVowelSound(phrase) ? 'an' : 'a';
}

export function withArticle(phrase: string): string {
  return `${article(phrase)} ${phrase}`;
}

/** Returns each "a"/"an" misuse found in the text, e.g. ["a owl", "an cat"]. */
export function findArticleErrors(text: string): string[] {
  const errors: string[] = [];
  const re = /\b(a|an)\s+([A-Za-z0-9][\w'-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const art = m[1].toLowerCase();
    const word = m[2];
    const vowel = startsWithVowelSound(word);
    if (art === 'a' && vowel) errors.push(m[0]);
    if (art === 'an' && !vowel) errors.push(m[0]);
  }
  return errors;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
