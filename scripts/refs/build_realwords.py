"""Writes scripts/refs/real-words.txt: everyday English words the typo fixer must leave alone.

The fixer turns an unknown word into the nearest vocabulary word ("drgon" -> "dragon"), but many real words
sit a letter or two from one ("thorn" -> "throne", "arid" -> "raid", "grim" -> "grimdark"). This lists the
frequent English words (wordfreq Zipf >= 3.0; typos in the wild score far lower: "castel" 2.5, "mountian" 1.3)
that aren't vocabulary words but are within two edits of one with the same first letter, i.e. the ones at
risk. build-vocab.mjs puts them in vocab.json.

usage: python build_realwords.py      (needs `pip install wordfreq`; run again after the vocabulary changes)
"""
import json, os, re
from wordfreq import top_n_list, zipf_frequency

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(os.path.dirname(__file__), 'real-words.txt')
ZIPF = 3.0


def deletes(w, n=2):
    out, frontier = {w}, {w}
    for _ in range(n):
        frontier = {x[:i] + x[i + 1:] for x in frontier for i in range(len(x))}
        out |= frontier
    return out


if __name__ == '__main__':
    vocab = json.load(open(os.path.join(ROOT, 'public', 'refs', 'vocab.json')))
    keys = [k for g in vocab['keys'] for k in (g if isinstance(g, list) else [g])]
    tokens = {t for k in keys for t in re.findall(r"[a-z'-]+", k)}
    # symmetric-delete index of the vocabulary: two words within two edits share a delete
    index = {}
    for t in tokens:
        for d in deletes(t):
            index.setdefault(d, set()).add(t)
    risky = []
    for w in top_n_list('en', 80000):
        if not re.fullmatch(r'[a-z]{4,15}', w) or w in tokens or zipf_frequency(w, 'en') < ZIPF:
            continue
        near = {t for d in deletes(w) for t in index.get(d, ()) if t[0] == w[0] or (t[:2] == w[1::-1])}
        if near:
            risky.append(w)
    open(OUT, 'w').write('\n'.join(sorted(risky)) + '\n')
    print(f'{len(risky)} real words near vocabulary words -> {OUT}')
