// Builds public/refs/feed.json: recent card-game art (2021 and newer) for the start screen's feed.
// The feed shows new work first — ArtStation's trending 2D art and new MTG art come live; this file
// adds recent League skins, Hearthstone sets and Riftbound. Searches never use it (they rank by match).
//
// Rows: [source, year, row number in the catalog, ...the catalog's own row without its words] — the app
// turns a catalog row into image URLs itself, and reads the row's vector from the catalog's index by its
// number, so this file stays small and feed cards need no model work.
//
// usage: node scripts/refs/build-feed.mjs      (after build-catalogs)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CAT = path.join(ROOT, 'public', 'refs', 'catalogs');
const FROM = 2021;
const CAP = { lol: 700, hearthstone: 900, riftbound: 700 }; // rows per game, newest first

const get = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'ArtBriefFeed/1.0 (+https://kumikilongyeyo.github.io/art-brief/)' } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};
// each row tagged with its position: the index files are keyed by it
const catalog = (name) => JSON.parse(fs.readFileSync(path.join(CAT, `${name}.json`), 'utf8')).map((r, i) => Object.assign(r, { at: i }));
const slim = (row) => [row[0], row[1], '', ...row.slice(3)]; // drop the search words

// Hearthstone's card data has no dates: its expansions, by the year they came out
const HS_YEAR = {
  THE_BARRENS: 2021, STORMWIND: 2021, ALTERAC_VALLEY: 2021,
  THE_SUNKEN_CITY: 2022, REVENDRETH: 2022, RETURN_OF_THE_LICH_KING: 2022, PATH_OF_ARTHAS: 2022,
  BATTLE_OF_THE_BANDS: 2023, TITANS: 2023, WILD_WEST: 2023, WONDERS: 2023,
  WHIZBANGS_WORKSHOP: 2024, ISLAND_VACATION: 2024, SPACE: 2024,
  EMERALD_DREAM: 2025, THE_LOST_CITY: 2025, TIME_TRAVEL: 2025,
  CATACLYSM: 2026, ESCAPEFROM_VIOLET_HOLD: 2026,
};
// Riftbound sets by card-id prefix: Origins (and its starter decks) 2025, everything after 2026
const RB_YEAR = (id) => (/^og[ns]-/.test(id) ? 2025 : 2026);

const out = [];
const take = (src, rows) => {
  rows.sort((a, b) => b[0] - a[0]);
  const kept = rows.slice(0, CAP[src]);
  for (const [year, row] of kept) out.push([src, year, row.at, ...slim(row)]);
  const years = {};
  for (const [y] of kept) years[y] = (years[y] ?? 0) + 1;
  console.log(`${src}: ${kept.length} of ${rows.length} recent`, years);
};

// League: skin release dates (and the splash artists) from Meraki Analytics
{
  const meraki = await get('https://cdn.merakianalytics.com/riot/lol/resources/latest/en-US/champions.json');
  const info = new Map();
  for (const champ of Object.values(meraki))
    for (const s of champ.skins ?? []) {
      const num = Number(s.id) % 1000;
      info.set(`${champ.key}_${num}`, { year: Number(String(s.release ?? '').slice(0, 4)) || 0, artist: (s.splashArtist ?? []).join(', ') });
    }
  const rows = [];
  for (const r of catalog('lol')) {
    const m = info.get(r[0]);
    if (!m || m.year < FROM) continue;
    const row = Object.assign([...r], { at: r.at });
    row[3] = m.artist || row[3] || '';
    rows.push([m.year, row]);
  }
  take('lol', rows);
}

// Hearthstone
{
  const cards = await get('https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json');
  const year = new Map(cards.map((c) => [c.id, HS_YEAR[c.set] ?? 0]));
  take('hearthstone', catalog('hearthstone').filter((r) => (year.get(r[0]) ?? 0) >= FROM).map((r) => [year.get(r[0]), r]));
}

// Riftbound: all of it is recent
take('riftbound', catalog('riftbound').map((r) => [RB_YEAR(r[0]), r]));

fs.writeFileSync(path.join(ROOT, 'public', 'refs', 'feed.json'), JSON.stringify(out));
console.log(`feed: ${out.length} rows, ${(fs.statSync(path.join(ROOT, 'public', 'refs', 'feed.json')).size / 1024).toFixed(0)} KB`);
