// Snapshots small card catalogs into public/refs/catalogs/<id>.json so the app can search them
// locally (these sources have no search API the browser can call). Re-run to refresh.
//   node scripts/refs/build-catalogs.mjs
// Row: [id, title, words, artist?, img?] — image and page URLs are rebuilt from the id in src/refs/sources.ts
// (Riftbound keeps its image path because it can't be derived).
import fs from 'node:fs';
import path from 'node:path';
const OUT = new URL('../../public/refs/catalogs/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const UA = { 'User-Agent': 'ArtBriefCatalogs/1.0', Accept: 'application/json' };
const get = async (u, json = true) => {
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  return json ? r.json() : r.text();
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
const save = (id, rows) => {
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rows));
  console.log(id, rows.length, `${(fs.statSync(path.join(OUT, `${id}.json`)).size / 1e3).toFixed(0)}KB`);
};

// League of Legends: every skin's art. Words = champion name, title, class tags and the skin's own name
// (lore blurbs made every Vi skin match "woman"). Skins without portrait ("loading") art are marked
// so the app shows the splash instead of a 404.
{
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
{
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
{
  const d = await get('https://api.hearthstonejson.com/v1/latest/enUS/cards.collectible.json');
  const rows = d
    .filter((c) => c.type !== 'HERO' || c.set === 'CORE')
    .map((c) => [c.id, c.name, W(c.name, (c.races ?? [c.race ?? '']).join(' '), c.type, c.cardClass, KEY(c.flavor ?? '')), c.artist ?? '']);
  save('hearthstone', rows);
}
// D&D 5e SRD monsters that have official art.
{
  const list = await get('https://www.dnd5eapi.co/api/2014/monsters');
  const rows = [];
  for (let i = 0; i < list.results.length; i += 20) {
    const chunk = await Promise.all(list.results.slice(i, i + 20).map((m) => get(`https://www.dnd5eapi.co${m.url}`).catch(() => null)));
    for (const m of chunk) if (m?.image) rows.push([m.index, m.name, W(m.name, m.type, m.subtype ?? '', m.size, m.alignment)]);
  }
  save('dnd', rows);
}
