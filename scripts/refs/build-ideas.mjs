// Builds public/refs/ideas.json: the start screen's idea tiles, each with the catalog art that best
// matches it. The start screen shows a different 8 of them, each with a different picture, on every
// visit — without loading a catalog (hearthstone.json alone is ~870 KB).
//
// It runs the app's own search code (through Vite) against the files in public/, so a tile's pictures
// are exactly what that search ranks first.
//
// usage: node scripts/refs/build-ideas.mjs      (after build-vocab, build-catalogs and build_index)
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PUBLIC = path.join(ROOT, 'public');
const PER_IDEA = 8; // pictures kept per idea

// [label shown, query run when clicked, mode, catalogs to draw pictures from]
const IDEAS = [
  ['Sword fighters', 'warrior holding a sword', 'pose', ['lol', 'hearthstone', 'riftbound']],
  ['Dragons', 'dragon', 'creature', ['hearthstone', 'riftbound', 'dnd', 'lol']],
  ['Castles & ruins', 'castle ruins', 'place', ['hearthstone', 'riftbound']],
  ['Champion art', 'fantasy champion portrait', 'concept', ['lol']],
  ['Mages casting spells', 'mage casting a spell', 'pose', ['lol', 'hearthstone', 'riftbound']],
  ['Archers', 'archer drawing a bow', 'pose', ['lol', 'hearthstone', 'riftbound']],
  ['Knights in armor', 'knight in armor', 'concept', ['hearthstone', 'lol', 'riftbound']],
  ['Monsters', 'monster', 'creature', ['dnd', 'hearthstone', 'riftbound']],
  ['Undead', 'skeleton undead', 'creature', ['hearthstone', 'dnd', 'lol']],
  ['Demons', 'demon', 'creature', ['hearthstone', 'dnd', 'riftbound']],
  ['Wolves & beasts', 'wolf', 'creature', ['hearthstone', 'dnd', 'lol']],
  ['Giants & golems', 'golem', 'creature', ['hearthstone', 'dnd']],
  ['Sea creatures', 'sea monster', 'creature', ['hearthstone', 'dnd', 'riftbound']],
  ['Birds & griffins', 'griffin', 'creature', ['hearthstone', 'dnd']],
  ['Forests', 'enchanted forest', 'place', ['hearthstone', 'riftbound']],
  ['Taverns & interiors', 'tavern interior', 'place', ['hearthstone', 'riftbound']],
  ['Cities & streets', 'fantasy city street', 'place', ['riftbound', 'hearthstone', 'lol']],
  ['Temples & shrines', 'temple', 'place', ['hearthstone', 'riftbound']],
  ['Caves & dungeons', 'dungeon', 'place', ['hearthstone', 'riftbound']],
  ['Snow & ice', 'snowy mountains', 'place', ['hearthstone', 'riftbound', 'lol']],
  ['Deserts', 'desert', 'place', ['hearthstone', 'riftbound']],
  ['Magic weapons', 'magic sword', 'prop', ['hearthstone', 'riftbound']],
  ['Potions & scrolls', 'potion', 'prop', ['hearthstone', 'riftbound']],
  ['Treasure', 'treasure chest', 'prop', ['hearthstone', 'riftbound']],
  ['Shields', 'shield', 'prop', ['hearthstone', 'riftbound']],
  ['Pirates', 'pirate', 'concept', ['hearthstone', 'lol', 'riftbound']],
  ['Witches', 'witch', 'concept', ['hearthstone', 'lol', 'riftbound']],
  ['Ninjas & assassins', 'assassin', 'concept', ['lol', 'hearthstone', 'riftbound']],
  ['Robots & mechs', 'robot', 'concept', ['lol', 'hearthstone', 'riftbound']],
  ['Cyberpunk', 'cyberpunk', 'concept', ['lol', 'riftbound']],
  ['Cute creatures', 'cute creature', 'creature', ['lol', 'hearthstone', 'riftbound']],
  ['Old wise men', 'old wizard', 'concept', ['hearthstone', 'lol']],
  ['Martial arts', 'martial arts fighter', 'pose', ['lol', 'hearthstone', 'riftbound']],
  ['Dancers', 'dancer', 'pose', ['lol', 'hearthstone', 'riftbound']],
];
// (no Wikimedia pictures here: Commons rate-limits thumbnails, and a start tile must always load)

// serve public/ to the app code's fetch() calls
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('/art-brief/')) return realFetch(url, init);
  const file = path.join(PUBLIC, decodeURIComponent(u.replace('/art-brief/', '').split('?')[0]));
  if (!fs.existsSync(file)) return new Response('missing', { status: 404 });
  return new Response(fs.readFileSync(file), { status: 200 });
};

const vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { loadVocab, makePlan, queryVector } = await vite.ssrLoadModule('/src/refs/vocab.ts');
  const { SOURCE_BY_ID } = await vite.ssrLoadModule('/src/refs/sources.ts');
  const v = await loadVocab();
  const out = [];
  for (const [label, q, mode, cats] of IDEAS) {
    const plan = makePlan(v, q, mode, false);
    const vec = await queryVector(v, plan);
    const ctx = { q: vec, memo: new Map() };
    const found = [];
    for (const cat of cats) {
      const page = await SOURCE_BY_ID[cat].search(plan, 0, new AbortController().signal, ctx);
      for (const c of page.items.slice(0, 12)) {
        let s = 0;
        if (c.vec && vec) for (let d = 0; d < vec.length; d++) s += c.vec[d] * vec[d];
        found.push({ s, img: c.thumb });
      }
    }
    const imgs = found.sort((a, b) => b.s - a.s).slice(0, PER_IDEA).map((f) => f.img);
    if (imgs.length < 3) {
      console.warn(`${label}: only ${imgs.length} pictures — skipped`);
      continue;
    }
    out.push({ label, q, mode, imgs });
    console.log(`${label}: ${imgs.length}`);
  }
  fs.writeFileSync(path.join(PUBLIC, 'refs', 'ideas.json'), JSON.stringify(out));
  console.log(`ideas: ${out.length}`);
} finally {
  await vite.close();
}
