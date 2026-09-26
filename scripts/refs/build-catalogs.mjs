// Snapshots small card catalogs into public/refs/catalogs/<id>.json so the app can search them
// locally (these sources have no search API the browser can call). Re-run to refresh.
//   node scripts/refs/build-catalogs.mjs [catalog ...]    (no names = all of them)
// Row: [id, title, words, artist?, img?] — image and page URLs are rebuilt from the id in src/refs/sources.ts
// (Riftbound keeps its image path because it can't be derived).
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const OUT = new URL('../../public/refs/catalogs/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'ArtBriefCatalogs/1.0', Accept: 'application/json' };
const get = async (u, json = true) => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(u, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${u}`);
      return await (json ? r.json() : r.text());
    } catch (e) {
      if (a >= 2) throw e; // a dropped connection now and then: try twice more
      await sleep(2000 * (a + 1));
    }
  }
};
const W = (...xs) =>
  [
    ...new Set(
      xs
        .join(' ')
        .toLowerCase()
        .replace(/<[^>]+>/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    ),
  ].join(' ');
// A few telling words from a long description (skips common English).
const COMMON = new Set(
  'the and that with from this have they their were been will into when then than them what which there about would could after before where while over under more most such only also some other these those being because through during against between'.split(
    ' ',
  ),
);
const KEY = (s) =>
  W(s)
    .split(' ')
    .filter((w) => !COMMON.has(w))
    .slice(0, 10)
    .join(' ');
const ONLY = process.argv.slice(2);
const want = (id) => !ONLY.length || ONLY.includes(id);
const save = (id, rows) => {
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rows));
  console.log(id, rows.length, `${(fs.statSync(path.join(OUT, `${id}.json`)).size / 1e3).toFixed(0)}KB`);
};

// League of Legends: every skin's art. Words = champion name, title, class tags and the skin's own name
// (lore blurbs made every Vi skin match "woman"). Skins without portrait ("loading") art are marked
// so the app shows the splash instead of a 404.
if (want('lol')) {
  const [ver] = await get('https://ddragon.leagueoflegends.com/api/versions.json');
  const full = await get(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/championFull.json`);
  const rows = [];
  for (const c of Object.values(full.data)) {
    for (const s of c.skins) {
      if ('parentSkin' in s) continue; // chroma recolours: listed as skins but have no art of their own
      const skin = s.num === 0 ? c.name : s.name;
      rows.push([`${c.id}_${s.num}`, skin === 'default' ? c.name : skin, W(c.name, c.title, c.tags.join(' '), skin)]);
    }
  }
  const ok = async (id) => { for (let a = 0; a < 3; a++) { try { const r = await fetch(`https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${id}.jpg`, { method: 'HEAD', headers: UA }); return r.ok; } catch { /* retry */ } } return false; };
  for (let i = 0; i < rows.length; i += 48) {
    const chunk = rows.slice(i, i + 48);
    const res = await Promise.all(chunk.map((r) => ok(r[0])));
    res.forEach((good, j) => { if (!good) chunk[j].push('', 'splash'); });
  }
  console.log('lol skins without portrait art:', rows.filter((r) => r[4] === 'splash').length);
  save('lol', rows);
}
// Riftbound: the public card gallery page embeds every card. Only human labels are indexed
// (name, champion tags, type, domain) — the rest of the record is image metadata.
if (want('riftbound')) {
  const html = await get('https://playriftbound.com/en-us/card-gallery/', false);
  const nd = JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const cards = [];
  (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.cardImage?.url && typeof x.name === 'string') cards.push(x); Object.values(x).forEach(walk); } })(nd);
  const seen = new Set(); const rows = [];
  for (const c of cards) {
    const url = c.cardImage.url.split('?')[0];
    if (seen.has(url)) continue; seen.add(url);
    const labels = [...(c.tags?.tags ?? []), ...(c.cardType?.type ?? []).map((x) => x.label), ...(c.domain?.values ?? []).map((x) => x.label)];
    const artist = c.illustrator?.values?.[0]?.label;
    rows.push([c.id ?? url.split('/').pop(), c.name, W(c.name, labels.join(' ')), artist ?? '', url.replace('https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/', '')]);
  }
  save('riftbound', rows);
}
// Hearthstone: collectible cards, art-only renders.
if (want('hearthstone')) {
  const d = await get('https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json');
  const rows = d
    .filter((c) => c.type !== 'HERO' || c.set === 'CORE')
    .map((c) => [c.id, c.name, W(c.name, (c.races ?? [c.race ?? '']).join(' '), c.type, c.cardClass, KEY(c.flavor ?? '')), c.artist ?? '']);
  save('hearthstone', rows);
}
// D&D 5e SRD monsters that have official art.
if (want('dnd')) {
  const list = await get('https://www.dnd5eapi.co/api/2014/monsters');
  const rows = [];
  for (let i = 0; i < list.results.length; i += 20) {
    const chunk = await Promise.all(list.results.slice(i, i + 20).map((m) => get(`https://www.dnd5eapi.co${m.url}`).catch(() => null)));
    for (const m of chunk) if (m?.image) rows.push([m.index, m.name, W(m.name, m.type, m.subtype ?? '', m.size, m.alignment)]);
  }
  save('dnd', rows);
}
// Flesh and Blood: the-fab-cube's open card dataset. One row per artwork: the three pitch colours of a card
// share one picture, and so do its reprints, foils and extended-art printings; an alternate art is its own.
// Row: [image name, card name, words, artists, FaBrary page slug]. Only full-card scans exist, so the app
// and the index both crop the art window (FAB_ART in src/refs/sources.ts and build_index.py).
if (want('fab')) {
  const cards = await get('https://raw.githubusercontent.com/the-fab-cube/flesh-and-blood-cards/develop/json/english/card.json');
  const IMG = /^https:\/\/legendstory-production-s3-public\.s3\.amazonaws\.com\/media\/cards\/large\/([^/]+)\.webp$/;
  // game terms that say nothing about the picture
  const RULES = new Set(['Action', 'Attack', 'Attack Reaction', 'Defense Reaction', 'Instant', 'Generic', 'Block', 'Resource', 'Base', 'Young', '1H', '2H', 'Evo', 'Token']);
  // FaBrary's page names: punctuation dropped, spaces to dashes, then the pitch colour ("10000-year-reunion-red")
  const slug = (c) => [c.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-'), c.color?.toLowerCase()].filter(Boolean).join('-');
  const best = new Map(); // art → [score, row]
  for (const c of cards) {
    for (const p of c.printings) {
      const m = IMG.exec(p.image_url ?? '');
      const v = p.art_variations ?? [];
      // landscape and split cards and back faces have no art window where the crop expects it
      if (!m || m[1].includes('_BACK') || p.image_rotation_degrees || c.name.includes('//') || v.includes('HS')) continue;
      const art = `${c.name}|${[...p.artists].sort().join(',')}|${v.includes('AA') ? 'aa' : ''}`;
      // the plain frame crops cleanest; extended and full art move the frame about
      const score = (v.includes('FA') ? 2 : 0) + (v.includes('EA') || v.includes('AB') ? 1 : 0) + (p.edition === 'A' ? 0.5 : 0);
      if (best.has(art) && best.get(art)[0] <= score) continue;
      const types = c.types.filter((t) => !RULES.has(t));
      best.set(art, [score, [m[1], c.name, W(c.name, types.join(' '), (c.traits ?? []).join(' '), KEY(p.flavor_text_plain ?? '')), p.artists.join(', '), slug(c)]]);
    }
  }
  save('fab', [...best.values()].map(([, row]) => row));
}
// Pokémon TCG: the card data behind api.pokemontcg.io (PokemonTCG/pokemon-tcg-data on GitHub: the same
// records, without the API's rate limits and outages). Pokémon only (trainers and energy aren't creature art),
// 2020 on, no recoloured reprints (gold, rainbow, shiny). One row per artwork (name + artist + rarity), the
// full-art rarities first and then the newest regular cards, up to 4000. Row: [card id, name, words, artist,
// 'f' when the art fills the card] — full-art cards are cropped differently (see src/refs/sources.ts).
if (want('pokemon')) {
  const DATA = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master';
  const FULL = new Set(['Illustration Rare', 'Special Illustration Rare', 'Ultra Rare', 'Rare Ultra', 'Double Rare', 'Rare Holo V', 'Rare Holo VMAX', 'Rare Holo VSTAR', 'Holo Rare V', 'Holo Rare VMAX', 'Holo Rare VSTAR', 'Trainer Gallery Rare Holo']);
  const REGULAR = new Set(['Common', 'Uncommon', 'Rare', 'Rare Holo']);
  // energy, shiny vaults, classic reprints, promos (mostly reprints, in odd frames), McDonald's minis
  const SKIP = new Set(['sve', 'swsh45sv', 'cel25c', 'me55c', 'fut20', 'mcd21', 'mcd22', 'svp', 'swshp']);
  const sets = (await get(`${DATA}/sets/en.json`)).filter((s) => s.releaseDate >= '2020/01' && !SKIP.has(s.id));
  const date = Object.fromEntries(sets.map((s) => [s.id, s.releaseDate]));
  const cards = [];
  for (let i = 0; i < sets.length; i += 8) {
    for (const list of await Promise.all(sets.slice(i, i + 8).map((s) => get(`${DATA}/cards/en/${s.id}.json`)))) cards.push(...list);
  }
  const art = new Map();
  for (const c of cards) {
    const set = c.id.slice(0, c.id.lastIndexOf('-'));
    if (c.supertype !== 'Pokémon' || !(FULL.has(c.rarity) || REGULAR.has(c.rarity)) || !date[set]) continue;
    // a reprint keeps its name, artist and rarity; newer sets often have no artist yet, so they don't merge
    const key = `${c.name}|${c.artist ?? c.id}|${c.rarity}`;
    const prev = art.get(key);
    if (!prev || prev.d < date[set]) art.set(key, { d: date[set], c });
  }
  const pick = [...art.values()].sort((a, b) => FULL.has(b.c.rarity) - FULL.has(a.c.rarity) || b.d.localeCompare(a.d)).slice(0, 4000);
  const rows = pick
    .sort((a, b) => b.d.localeCompare(a.d))
    .map(({ c }) => [c.id, c.name, W(c.name, 'pokemon', (c.types ?? []).join(' '), KEY(c.flavorText ?? '')), c.artist ?? '', FULL.has(c.rarity) ? 'f' : '']);
  console.log('pokemon full-art rows:', rows.filter((r) => r[4] === 'f').length);
  save('pokemon', rows);
}
