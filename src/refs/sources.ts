import { byPose, figureRows, nearest, vectorOf } from './idx';
import { catalog, getJson, qs, RELAY, showUrl } from './net';
import { rngFrom } from '../engine/rng';
import type { Cand, EffMode, Page, Plan, SearchCtx, Source, SourceId } from './types';

/** trust per mode: pose, concept, place, prop, creature */
const T = (pose: number, concept: number, place: number, prop: number, creature: number): Record<EffMode, number> => ({
  pose,
  concept,
  place,
  prop,
  creature,
});
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
const text = (p: Plan) => p.text;
const nounText = (p: Plan) => (p.nouns.length ? p.nouns.join(' ') : p.words.slice(0, 3).join(' '));
const none: Page = { items: [], more: false };
/** Remote titles can carry markup ("<div class='fn'>…"): keep the text only. */
const clean = (s: string | undefined, fallback: string) => (s ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() || fallback;

// ---------------------------------------------------------------- fantasy art (relay)

type ArtStationProject = {
  hash_id: string;
  title: string;
  url: string;
  smaller_square_cover_url: string;
  hide_as_adult?: boolean;
  is_adult_content?: boolean;
  user?: { full_name?: string };
};
const artstationCand = (x: ArtStationProject, i: number): Cand => ({
  key: `artstation:${x.hash_id}`,
  src: 'artstation',
  title: x.title,
  pos: i,
  thumb: x.smaller_square_cover_url,
  full: x.smaller_square_cover_url.replace('/smaller_square/', '/large/'),
  page: x.url,
  artist: x.user?.full_name,
  tags: words(x.title),
  aspect: 1,
  adult: !!(x.hide_as_adult || x.is_adult_content),
  // image paths carry their upload time (…/20260925071734/…); covers don't, and trending work is new anyway
  year: Number(/\/(20\d\d)\d{10}\//.exec(x.smaller_square_cover_url)?.[1]) || new Date().getFullYear(),
});
const artstation: Source = {
  id: 'artstation',
  label: 'ArtStation',
  trust: T(0.95, 0.95, 0.9, 0.85, 0.9),
  async search(p, page, signal) {
    if (!RELAY) return none;
    const r = await getJson<{ data?: ArtStationProject[] }>(`${RELAY}/artstation?${qs({ q: text(p), page: page + 1, n: 30 })}`, signal);
    const items = (r.data ?? []).map(artstationCand);
    return { items, more: items.length >= 25 && page < 8 };
  },
};

const wallhaven: Source = {
  id: 'wallhaven',
  label: 'Wallhaven',
  trust: T(0.6, 0.85, 0.9, 0.5, 0.8),
  async search(p, page, signal) {
    if (!RELAY) return none;
    const r = await getJson<{
      data?: Array<{ id: string; url: string; purity: string; ratio: string; thumbs: { small: string; large: string }; path: string }>;
      meta?: { last_page?: number };
    }>(`${RELAY}/wallhaven?${qs({ q: nounText(p) || text(p), page: page + 1, adult: p.adult ? 1 : 0 })}`, signal);
    const items = (r.data ?? []).map((x, i): Cand => ({
      key: `wallhaven:${x.id}`,
      src: 'wallhaven',
      title: 'Wallhaven wallpaper',
      pos: i,
      thumb: x.thumbs.large,
      rankThumb: x.thumbs.small,
      full: x.path,
      page: x.url,
      tags: [],
      aspect: parseFloat(x.ratio) || 1.78,
      adult: x.purity !== 'sfw',
    }));
    return { items, more: (r.meta?.last_page ?? 1) > page + 1 && page < 6 };
  },
};

const safebooru: Source = {
  id: 'safebooru',
  label: 'Safebooru',
  trust: T(0.6, 0.4, 0.3, 0.35, 0.4),
  async search(p, page, signal) {
    if (!RELAY || !p.booru.length) return none;
    const tags = [...new Set(p.booru)].slice(0, 3).join(' ') + (p.adult ? '' : ' -rating:questionable');
    const r = await getJson<
      Array<{
        id: number;
        preview_url: string;
        sample_url: string;
        file_url: string;
        width: number;
        height: number;
        tags: string;
        rating: string;
      }>
    >(`${RELAY}/safebooru?${qs({ tags, page, n: 40 })}`, signal);
    const list = Array.isArray(r) ? r : [];
    const items = list.map((x, i): Cand => ({
      key: `safebooru:${x.id}`,
      src: 'safebooru',
      title: 'Safebooru illustration',
      pos: i,
      thumb: x.sample_url || x.preview_url,
      rankThumb: x.preview_url,
      full: x.sample_url || x.file_url,
      page: `https://safebooru.org/index.php?page=post&s=view&id=${x.id}`,
      tags: x.tags.replace(/_/g, ' ').split(' '),
      aspect: x.width / x.height || 0.75,
      adult: x.rating === 'questionable' || x.rating === 'explicit',
    }));
    return { items, more: list.length >= 40 && page < 6 };
  },
};

// ---------------------------------------------------------------- open photo & art libraries

const openverse: Source = {
  id: 'openverse',
  label: 'Openverse',
  trust: T(0.75, 0.8, 0.85, 0.75, 0.75),
  async search(p, page, signal) {
    const r = await getJson<{
      results?: Array<{
        id: string;
        title: string;
        thumbnail: string;
        url: string;
        foreign_landing_url: string;
        creator?: string;
        tags?: Array<{ name: string }>;
        mature?: boolean;
        width?: number;
        height?: number;
      }>;
      page_count?: number;
    }>(
      `https://api.openverse.org/v1/images/?${qs({ q: text(p), page_size: 20, page: page + 1, mature: p.adult ? undefined : 'false' })}`,
      signal,
    );
    const items = (r.results ?? []).map((x, i): Cand => ({
      key: `openverse:${x.id}`,
      src: 'openverse',
      title: clean(x.title, 'Openverse image'),
      pos: i,
      thumb: x.thumbnail,
      rankThumb: x.url,
      full: x.url,
      page: x.foreign_landing_url,
      artist: x.creator,
      tags: (x.tags ?? []).map((t) => t.name.toLowerCase()),
      aspect: x.width && x.height ? x.width / x.height : undefined,
      adult: !!x.mature,
    }));
    return { items, more: (r.page_count ?? 0) > page + 1 && page < 2 }; // anonymous limit is 200 calls a day
  },
};

type MwPage = {
  pageid: number;
  title: string;
  imageinfo?: Array<{ thumburl?: string; url: string; descriptionurl: string; width: number; height: number; mime?: string }>;
};
/** Any MediaWiki: Commons, Fandom wikis, UESP, Pathfinder — file search with thumbnails. */
/** `proxied`: the wiki's image host refuses to be shown on other sites (Fandom sends a same-origin
 *  resource policy), so its thumbnails are shown through wsrv.nl. */
function mediawiki(id: SourceId, label: string, api: string, trust: Record<EffMode, number>, extra = '', corsThumb = false, proxied = false): Source {
  return {
    id,
    label,
    trust,
    corsThumb,
    async search(p, page, signal) {
      const r = await getJson<{ query?: { pages?: Record<string, MwPage> }; continue?: unknown }>(
        `${api}?${qs({ action: 'query', generator: 'search', gsrsearch: `${text(p)}${extra}`, gsrnamespace: 6, gsrlimit: 20, gsroffset: page * 20, prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: 480, format: 'json', origin: '*' })}`,
        signal,
      );
      const pages = Object.values(r.query?.pages ?? {}) as Array<MwPage & { index?: number }>;
      pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const items: Cand[] = [];
      pages.forEach((x, i) => {
        const ii = x.imageinfo?.[0];
        if (!ii || !/^image\/(jpeg|png|webp)/.test(ii.mime ?? 'image/jpeg') || ii.width < 200) return;
        const name = x.title
          .replace(/^File:/, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ');
        items.push({
          key: `${id}:${x.pageid}`,
          src: id,
          title: name,
          pos: i,
          thumb: proxied ? showUrl(ii.thumburl ?? ii.url) : (ii.thumburl ?? ii.url),
          rankThumb: ii.thumburl ?? ii.url, // the ranking fetch adds its own wsrv.nl step
          full: proxied ? showUrl(ii.url, 1200) : ii.url,
          page: ii.descriptionurl,
          tags: words(name),
          aspect: ii.width / ii.height,
        });
      });
      return { items, more: !!r.continue && page < 5 };
    },
  };
}

const commons = mediawiki(
  'commons',
  'Wikimedia Commons',
  'https://commons.wikimedia.org/w/api.php',
  T(0.6, 0.7, 0.85, 0.75, 0.7),
  ' filetype:bitmap',
  true,
);

const inat: Source = {
  id: 'inat',
  label: 'iNaturalist',
  trust: T(0, 0.2, 0.1, 0, 0.95),
  async search(p, page, signal) {
    const animal = p.nouns.find((n) => !FANTASY.has(n));
    if (!animal) return none;
    const r = await getJson<{
      results?: Array<{
        id: number;
        taxon?: { preferred_common_name?: string; name?: string };
        photos?: Array<{ url: string; attribution?: string }>;
      }>;
      total_results?: number;
    }>(
      `https://api.inaturalist.org/v1/observations?${qs({ q: animal, photos: 'true', quality_grade: 'research', per_page: 20, page: page + 1, order_by: 'votes' })}`,
      signal,
    );
    const items: Cand[] = [];
    (r.results ?? []).forEach((o, i) => {
      const ph = o.photos?.[0];
      if (!ph) return;
      const name = o.taxon?.preferred_common_name || o.taxon?.name || animal;
      items.push({
        key: `inat:${o.id}`,
        src: 'inat',
        title: name,
        pos: i,
        thumb: ph.url.replace('/square.', '/medium.'),
        full: ph.url.replace('/square.', '/large.'),
        page: `https://www.inaturalist.org/observations/${o.id}`,
        artist: ph.attribution?.replace(/^\(c\)\s*/, '').split(',')[0],
        tags: words(name),
      });
    });
    return { items, more: (r.total_results ?? 0) > (page + 1) * 20 && page < 5 };
  },
};
const FANTASY = new Set([
  'dragon',
  'wyvern',
  'drake',
  'hydra',
  'griffin',
  'gryphon',
  'phoenix',
  'pegasus',
  'unicorn',
  'manticore',
  'chimera',
  'minotaur',
  'centaur',
  'harpy',
  'siren',
  'mermaid',
  'kraken',
  'beholder',
  'troll',
  'ogre',
  'golem',
  'demon',
  'angel',
  'lich',
  'wraith',
  'werewolf',
  'goblin',
  'orc',
  'elf',
  'dwarf',
  'fairy',
  'giant',
  'basilisk',
  'owlbear',
]);

// ---------------------------------------------------------------- museums

const met: Source = {
  id: 'met',
  label: 'The Met',
  trust: T(0.25, 0.5, 0.35, 0.95, 0.4),
  async search(p, page, signal) {
    const q = nounText(p);
    if (!q) return none;
    const r = await getJson<{ objectIDs?: number[] | null }>(
      `https://collectionapi.metmuseum.org/public/collection/v1/search?${qs({ hasImages: 'true', q })}`,
      signal,
    );
    const ids = (r.objectIDs ?? []).slice(page * 12, page * 12 + 12);
    const objs = await Promise.all(
      ids.map((id) =>
        getJson<{
          objectID: number;
          title: string;
          primaryImageSmall?: string;
          primaryImage?: string;
          objectURL: string;
          artistDisplayName?: string;
          objectName?: string;
          tags?: Array<{ term: string }>;
        }>(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, signal).catch(() => null),
      ),
    );
    const items: Cand[] = [];
    objs.forEach((o, i) => {
      if (!o?.primaryImageSmall) return;
      items.push({
        key: `met:${o.objectID}`,
        src: 'met',
        title: o.title,
        pos: i,
        thumb: o.primaryImageSmall,
        full: o.primaryImage || o.primaryImageSmall,
        page: o.objectURL,
        artist: o.artistDisplayName || undefined,
        tags: [...words(o.title), ...words(o.objectName ?? ''), ...(o.tags ?? []).map((t) => t.term.toLowerCase())],
      });
    });
    return { items, more: (r.objectIDs?.length ?? 0) > (page + 1) * 12 && page < 4 };
  },
};

const cleveland: Source = {
  id: 'cleveland',
  label: 'Cleveland Museum of Art',
  trust: T(0.25, 0.5, 0.35, 0.9, 0.4),
  async search(p, page, signal) {
    const q = nounText(p);
    if (!q) return none;
    const r = await getJson<{
      data?: Array<{
        id: number;
        title: string;
        url: string;
        type?: string;
        creators?: Array<{ description: string }>;
        images?: { web?: { url: string; width: string; height: string } };
      }>;
      info?: { total: number };
    }>(`https://openaccess-api.clevelandart.org/api/artworks/?${qs({ q, has_image: 1, limit: 20, skip: page * 20 })}`, signal);
    const items: Cand[] = [];
    (r.data ?? []).forEach((x, i) => {
      const w = x.images?.web;
      if (!w) return;
      items.push({
        key: `cleveland:${x.id}`,
        src: 'cleveland',
        title: x.title,
        pos: i,
        thumb: w.url,
        full: w.url,
        page: x.url,
        artist: x.creators?.[0]?.description?.split('(')[0].trim(),
        tags: [...words(x.title), ...words(x.type ?? '')],
        aspect: +w.width / +w.height || undefined,
      });
    });
    return { items, more: (r.info?.total ?? 0) > (page + 1) * 20 && page < 4 };
  },
};

const artsmia: Source = {
  id: 'artsmia',
  label: 'Minneapolis Institute of Art',
  trust: T(0.2, 0.45, 0.35, 0.85, 0.35),
  async search(p, page, signal) {
    const q = nounText(p);
    if (!q) return none;
    const r = await getJson<{
      hits?: {
        hits?: Array<{
          _id: string;
          _source: {
            title?: string;
            artist?: string;
            image?: string;
            image_width?: number;
            image_height?: number;
            object_name?: string;
            classification?: string;
            restricted?: number;
          };
        }>;
        total?: number | { value: number };
      };
    }>(`https://search.artsmia.org/${encodeURIComponent(q)}?${qs({ size: 20, from: page * 20 })}`, signal);
    const items: Cand[] = [];
    (r.hits?.hits ?? []).forEach((x, i) => {
      const s = x._source;
      if (s.image !== 'valid' || s.restricted) return;
      const img = `https://1.api.artsmia.org/400/${x._id}.jpg`;
      items.push({
        key: `artsmia:${x._id}`,
        src: 'artsmia',
        title: s.title ?? 'Untitled',
        pos: i,
        thumb: img,
        full: `https://4.api.artsmia.org/800/${x._id}.jpg`,
        page: `https://collections.artsmia.org/art/${x._id}`,
        artist: s.artist,
        tags: [...words(s.title ?? ''), ...words(s.object_name ?? ''), ...words(s.classification ?? '')],
        aspect: s.image_width && s.image_height ? s.image_width / s.image_height : undefined,
      });
    });
    const total = typeof r.hits?.total === 'number' ? r.hits.total : (r.hits?.total?.value ?? 0);
    return { items, more: total > (page + 1) * 20 && page < 4 };
  },
};

const europeana: Source = {
  id: 'europeana',
  label: 'Europeana',
  trust: T(0.2, 0.55, 0.45, 0.7, 0.4),
  async search(p, page, signal) {
    const q = nounText(p);
    if (!q) return none;
    const r = await getJson<{
      items?: Array<{ id: string; title?: string[]; edmPreview?: string[]; guid: string; dcCreator?: string[] }>;
      totalResults?: number;
    }>(
      `https://api.europeana.eu/record/v2/search.json?${qs({ wskey: 'api2demo', query: q, rows: 20, start: page * 20 + 1, media: 'true', qf: 'TYPE:IMAGE', reusability: 'open' })}`,
      signal,
    );
    const items: Cand[] = [];
    (r.items ?? []).forEach((x, i) => {
      const prev = x.edmPreview?.[0];
      if (!prev) return;
      items.push({
        key: `europeana:${x.id}`,
        src: 'europeana',
        title: x.title?.[0] ?? q,
        pos: i,
        thumb: prev,
        full: prev.replace('type=IMAGE', 'type=IMAGE&size=w400'),
        page: x.guid.split('?')[0],
        artist: x.dcCreator?.[0],
        tags: words(x.title?.[0] ?? ''),
      });
    });
    return { items, more: (r.totalResults ?? 0) > (page + 1) * 20 && page < 4 };
  },
};

// ---------------------------------------------------------------- card games

// MTG creature types an artist is likely to ask for by name (Scryfall `t:`)
const MTG_TYPES = new Set(
  ('angel ape archer assassin bat bear beast bird boar cat centaur cleric crab crocodile cyclops deer demon devil ' +
    'dinosaur dog dragon drake druid dwarf elemental elephant elf faerie fish fox frog giant gnome goblin golem ' +
    'gorgon griffin horror horse hydra imp insect knight kraken leviathan lizard merfolk minotaur monk ninja ' +
    'octopus ogre orc owl ox pegasus phoenix pirate rat rhino rogue samurai satyr scorpion serpent shaman shark ' +
    'skeleton snake soldier specter sphinx spider spirit squirrel treefolk troll turtle unicorn vampire warrior ' +
    'werewolf whale wizard wolf wraith wurm zombie').split(' '),
);
const scryfall: Source = {
  id: 'scryfall',
  label: 'MTG (Scryfall)',
  sfw: true,
  corsThumb: true,
  trust: T(0.9, 0.9, 0.9, 0.85, 0.95),
  async search(p, page, signal) {
    type Card = {
      id: string;
      name: string;
      artist?: string;
      type_line?: string;
      scryfall_uri: string;
      image_uris?: { art_crop?: string };
      card_faces?: Array<{ image_uris?: { art_crop?: string } }>;
    };
    const run = (q: string) =>
      getJson<{ data?: Card[]; has_more?: boolean }>(
        `https://api.scryfall.com/cards/search?${qs({ q: `${q} -is:digital`, unique: 'art', order: 'edhrec', page: page + 1 })}`,
        signal,
      );
    let r: { data?: Card[]; has_more?: boolean } = {};
    // a creature or character is best found by card type: art tags are loose ("art:cat" is 1,189 cards,
    // led by Sol Ring for a cat on one printing)
    const kind = p.nouns.find((n) => MTG_TYPES.has(n));
    if (kind) r = await run(`t:${kind}${p.scry.filter((t) => t !== kind).slice(0, 1).map((t) => ` art:${t}`).join('')}`);
    if (kind && !r.data?.length) r = await run(`t:${kind}`);
    if (!r.data?.length && p.scry.length >= 2)
      r = await run(
        p.scry
          .slice(0, 3)
          .map((t) => `art:${t}`)
          .join(' '),
      );
    if (!r.data?.length && p.scry.length) r = await run(`(${p.scry.map((t) => `art:${t}`).join(' or ')})`);
    if (!r.data?.length) r = await run(nounText(p));
    const items: Cand[] = [];
    (r.data ?? []).slice(0, 40).forEach((c, i) => {
      const art = c.image_uris?.art_crop ?? c.card_faces?.[0]?.image_uris?.art_crop;
      if (!art) return;
      items.push({
        key: `scryfall:${c.id}`,
        src: 'scryfall',
        title: c.name,
        pos: i,
        thumb: art,
        full: art,
        page: c.scryfall_uri.split('?')[0],
        artist: c.artist,
        tags: [...words(c.name), ...words(c.type_line ?? '')],
        aspect: 1.37,
      });
    });
    return { items, more: !!r.has_more && page < 4 };
  },
};

const ygo: Source = {
  id: 'ygo',
  label: 'Yu-Gi-Oh!',
  sfw: true,
  trust: T(0.35, 0.6, 0.3, 0.4, 0.75),
  async search(p, page, signal) {
    const q = p.nouns[0];
    if (!q) return none;
    const r = await getJson<{
      data?: Array<{
        id: number;
        name: string;
        type: string;
        race?: string;
        ygoprodeck_url?: string;
        card_images?: Array<{ image_url_cropped: string; image_url: string }>;
      }>;
      meta?: { rows_remaining?: number };
    }>(`https://db.ygoprodeck.com/api/v7/cardinfo.php?${qs({ fname: q, num: 20, offset: page * 20 })}`, signal);
    const items = (r.data ?? [])
      .map((c, i): Cand => ({
        key: `ygo:${c.id}`,
        src: 'ygo',
        title: c.name,
        pos: i,
        thumb: c.card_images?.[0]?.image_url_cropped ?? '',
        full: c.card_images?.[0]?.image_url_cropped ?? '',
        page: c.ygoprodeck_url ?? `https://ygoprodeck.com/card/?search=${c.id}`,
        tags: [...words(c.name), ...words(c.race ?? ''), ...words(c.type)],
        aspect: 1,
      }))
      .filter((c) => c.thumb);
    return { items, more: (r.meta?.rows_remaining ?? 0) > 0 && page < 3 };
  },
};

const lorcana: Source = {
  id: 'lorcana',
  label: 'Disney Lorcana',
  sfw: true,
  trust: T(0.3, 0.45, 0.2, 0.2, 0.35),
  async search(p, page, signal) {
    const q = p.nouns[0];
    if (!q || page > 0) return none;
    const r = await getJson<{
      results?: Array<{
        id: string;
        name: string;
        version?: string;
        image_uris?: { digital?: { normal?: string; large?: string } };
        illustrators?: string[];
        classifications?: string[];
      }>;
    }>(`https://api.lorcast.com/v0/cards/search?${qs({ q })}`, signal);
    const items = (r.results ?? [])
      .slice(0, 20)
      .map((c, i): Cand => ({
        key: `lorcana:${c.id}`,
        src: 'lorcana',
        title: `${c.name}${c.version ? ' — ' + c.version : ''}`,
        pos: i,
        thumb: c.image_uris?.digital?.normal ?? '',
        full: c.image_uris?.digital?.large ?? '',
        page: `https://lorcast.com/cards/${c.id}`,
        artist: c.illustrators?.[0],
        tags: [...words(c.name), ...(c.classifications ?? []).map((x) => x.toLowerCase())],
        aspect: 0.72,
      }))
      .filter((c) => c.thumb);
    return { items, more: false };
  },
};

const swu: Source = {
  id: 'swu',
  label: 'Star Wars Unlimited',
  sfw: true,
  trust: T(0.3, 0.35, 0.2, 0.2, 0.25),
  async search(p, page, signal) {
    const q = p.nouns[0];
    if (!RELAY || !q || page > 0) return none;
    const r = await getJson<{
      data?: Array<{ Set: string; Number: string; Name: string; FrontArt: string; Artist?: string; Traits?: string[] }>;
    }>(`${RELAY}/swu?${qs({ q: `name:${q}` })}`, signal);
    const items = (r.data ?? []).slice(0, 20).map((c, i): Cand => ({
      key: `swu:${c.Set}-${c.Number}`,
      src: 'swu',
      title: c.Name,
      pos: i,
      thumb: c.FrontArt,
      full: c.FrontArt,
      page: `https://swudb.com/card/${c.Set}/${c.Number}`,
      artist: c.Artist,
      tags: [...words(c.Name), ...(c.Traits ?? []).map((t) => t.toLowerCase())],
      aspect: 0.72,
    }));
    return { items, more: false };
  },
};

// Static catalogs (scripts/refs/build-catalogs.mjs + build_index.py). With a query vector they're
// searched by look over the pre-analysed index (no downloads to rank them); with a pose, by pose over
// every figure; with neither, by the words attached to each card.
// Row: [id, title, words, artist?, img?, 'splash'?]; URLs are rebuilt here so the files stay small.
type CatRow = [string, string, string, string?, string?, string?];
type Urls = (row: CatRow) => { thumb: string; full: string; page: string; artist?: string; aspect: number };
const PER_PAGE = 30;
const CATALOG_URLS: Partial<Record<SourceId, Urls>> = {};
function catalogSource(id: SourceId, label: string, trust: Record<EffMode, number>, urls: Urls, sfw = true): Source {
  CATALOG_URLS[id] = urls;
  return {
    id,
    label,
    trust,
    local: true,
    sfw,
    async search(p, page, signal, ctx) {
      if (signal.aborted) return none;
      const rows = await catalog<CatRow[]>(id);
      const ranked = await rankedRows(id, rows, p, ctx);
      // Pose searches: the index already knows which cards show a figure (a lone sword card doesn't)
      const fig = p.mode === 'pose' ? await figureRows(id).catch(() => null) : null;
      const items = ranked.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map(({ row, vec, pose }, i): Cand => {
        const x = rows[row];
        return { key: `${id}:${x[0]}`, src: id, title: x[1], pos: page * PER_PAGE + i, tags: x[2].split(' '), vec, poseScore: pose, figure: fig ? fig(row) : undefined, ...urls(x) };
      });
      return { items, more: ranked.length > (page + 1) * PER_PAGE && page < 5 };
    },
  };
}
type Ranked = Array<{ row: number; vec?: Float32Array; pose?: number }>;
/** Computed once per search (kept in ctx.memo) and paged from. */
async function rankedRows(id: SourceId, rows: CatRow[], p: Plan, ctx: SearchCtx): Promise<Ranked> {
  const key = `cat:${id}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key) as Ranked;
  let out: Ranked = [];
  try {
    if (ctx.pose) {
      // every figure in the catalog, by pose; their vectors come along for the look score
      const hits = await byPose(id, ctx.pose, 90);
      out = await Promise.all(hits.map(async (h) => ({ row: h.row, pose: h.pose, vec: (await vectorOf(id, h.row)) ?? undefined })));
    } else if (ctx.q) {
      out = (await nearest(id, ctx.q, 180)).map((h) => ({ row: h.row, vec: h.vec }));
    }
  } catch {
    out = []; // index missing or unreadable: fall back to the words below
  }
  if (!out.length) {
    const want = new Set([...p.words, ...p.nouns]);
    const scored: Array<[number, number]> = [];
    rows.forEach((row, i) => {
      let s = 0;
      for (const w of row[2].split(' ')) if (want.has(w)) s += row[1].toLowerCase().includes(w) ? 2 : 1;
      if (s) scored.push([s, i]);
    });
    out = scored.sort((a, b) => b[0] - a[0]).map(([, row]) => ({ row }));
  }
  ctx.memo.set(key, out);
  return out;
}
const RB = 'https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/';
const riftbound = catalogSource('riftbound', 'Riftbound', T(0.7, 0.75, 0.4, 0.5, 0.55), (r) => ({
  thumb: showUrl(`${RB}${r[4]}`, 400), // the source serves the full card (~450 KB) whatever size is asked for
  full: showUrl(`${RB}${r[4]}`, 1000),
  page: 'https://playriftbound.com/en-us/card-gallery/',
  artist: r[3] || undefined,
  aspect: /-(\d+)x(\d+)\./.test(r[4] ?? '') ? +RegExp.$1 / +RegExp.$2 : 0.72,
}));
const lol = catalogSource('lol', 'League of Legends', T(0.85, 0.8, 0.4, 0.45, 0.6), (r) => {
  const splash = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${r[0]}.jpg`;
  const portrait = r[4] !== 'splash'; // rows are [id, title, words, artist, 'splash' when there's no portrait art]
  return {
    thumb: portrait ? `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${r[0]}.jpg` : showUrl(splash, 480),
    full: splash,
    page: `https://www.leagueoflegends.com/en-us/champions/${r[0].replace(/_\d+$/, '').toLowerCase()}/`,
    artist: r[3] || 'Riot Games',
    aspect: portrait ? 0.55 : 1.69,
  };
});
const hearthstone = catalogSource('hearthstone', 'Hearthstone', T(0.55, 0.7, 0.35, 0.45, 0.75), (r) => ({
  thumb: `https://art.hearthstonejson.com/v1/256x/${r[0]}.jpg`,
  full: `https://art.hearthstonejson.com/v1/512x/${r[0]}.jpg`,
  page: `https://hearthstone.wiki.gg/wiki/${encodeURIComponent(r[1].replace(/ /g, '_'))}`,
  artist: r[3] || undefined,
  aspect: 1,
}));
const dnd = catalogSource('dnd', 'D&D 5e', T(0.2, 0.4, 0.1, 0.2, 0.9), (r) => ({
  thumb: showUrl(`https://www.dnd5eapi.co/api/images/monsters/${r[0]}.png`, 400), // originals are 1.5–2 MB PNGs
  full: showUrl(`https://www.dnd5eapi.co/api/images/monsters/${r[0]}.png`, 1000),
  page: `https://www.dnd5eapi.co/api/2014/monsters/${r[0]}`,
  artist: 'Wizards of the Coast (SRD)',
  aspect: 1,
}));

// Pose library (scripts/refs/build_poselib.py): Wikimedia Commons photos of people in clear full-body
// poses — athletes, dancers, fencers, martial artists, reenactors. Stick-figure searches match these first.
const poses = catalogSource('poses', 'Pose library (Wikimedia)', T(0.95, 0.35, 0.1, 0.15, 0.1), (r) => ({
  thumb: `https://upload.wikimedia.org/wikipedia/commons/${r[4]}`,
  // the size the index build fetched is the one Wikimedia has already rendered; other sizes get rate-limited
  full: `https://upload.wikimedia.org/wikipedia/commons/${r[4]}`,
  page: `https://commons.wikimedia.org/?curid=${r[0]}`,
  artist: r[3] || undefined,
  aspect: 0.75,
}), false); // Commons photos: the adult check still applies

// ---------------------------------------------------------------- game-world wikis
const fandom = (id: SourceId, sub: string, label: string, trust: Record<EffMode, number>) =>
  mediawiki(id, label, `https://${sub}.fandom.com/api.php`, trust, '', false, true);
const forgottenrealms = fandom('forgottenrealms', 'forgottenrealms', 'Forgotten Realms Wiki', T(0.55, 0.7, 0.75, 0.65, 0.85));
const criticalrole = fandom('criticalrole', 'criticalrole', 'Critical Role Wiki', T(0.5, 0.6, 0.55, 0.45, 0.6));
const warhammer = fandom('warhammer', 'warhammerfantasy', 'Warhammer Fantasy Wiki', T(0.5, 0.6, 0.6, 0.55, 0.7));
const elderscrolls = fandom('elderscrolls', 'elderscrolls', 'Elder Scrolls Wiki', T(0.45, 0.6, 0.7, 0.6, 0.7));
const mtgwiki = fandom('mtgwiki', 'mtg', 'MTG Wiki', T(0.4, 0.6, 0.6, 0.4, 0.65));
const lolwiki = fandom('lolwiki', 'leagueoflegends', 'League Wiki', T(0.55, 0.65, 0.55, 0.45, 0.55));
const uesp = mediawiki('uesp', 'UESP', 'https://en.uesp.net/w/api.php', T(0.4, 0.55, 0.65, 0.6, 0.65), '', false, true);
const pathfinder = mediawiki('pathfinder', 'Pathfinder Wiki', 'https://pathfinderwiki.com/w/api.php', T(0.5, 0.65, 0.7, 0.6, 0.8), '', false, true);

// ---------------------------------------------------------------- the start screen's feed
// New work first, never ranked against a query: ArtStation's trending 2D art and new MTG art (live), plus
// recent League, Hearthstone and Riftbound art (public/refs/feed.json, scripts/refs/build-feed.mjs). A
// fresh mix every visit — searches never use these; they rank by match.
type FeedRow = [SourceId, number, number, ...CatRow]; // source, year, row in the catalog, catalog row
let feedRows: Promise<FeedRow[]> | null = null;
const loadFeedRows = () =>
  (feedRows ??= fetch(`${import.meta.env.BASE_URL}refs/feed.json?v=${__REFS_V__}`)
    .then((r) => (r.ok ? (r.json() as Promise<FeedRow[]>) : Promise.reject(new Error(String(r.status)))))
    .catch((e: unknown) => {
      feedRows = null;
      throw e;
    }));
declare const __REFS_V__: string;

export function feedSources(seed: string): Source[] {
  const rnd = rngFrom(seed);
  // trending changes daily; a random start page (and order within recent years) makes every visit different
  const asFrom = 1 + Math.floor(rnd() * 3);
  const scryFrom = 1 + Math.floor(rnd() * 5);
  const recentFirst = <T,>(rows: T[], year: (r: T) => number) =>
    rows
      .map((r) => [year(r) + rnd() * 2.5, r] as const) // mostly newest first, neighbouring years mixed
      .sort((a, b) => b[0] - a[0])
      .map(([, r]) => r);
  const trending: Source = {
    id: 'artstation',
    label: 'ArtStation',
    trust: T(1, 1, 1, 1, 1),
    async search(_p, page, signal) {
      if (!RELAY) return none;
      const r = await getJson<{ data?: ArtStationProject[] }>(`${RELAY}/artstation-feed?${qs({ page: asFrom + page, n: 30 })}`, signal);
      const items = (r.data ?? []).map(artstationCand);
      return { items, more: items.length >= 10 && page < 25 };
    },
  };
  const newMtg: Source = {
    id: 'scryfall',
    label: 'MTG (Scryfall)',
    sfw: true,
    corsThumb: true,
    trust: T(1, 1, 1, 1, 1),
    async search(_p, page, signal) {
      type Card = { id: string; name: string; artist?: string; released_at?: string; scryfall_uri: string; image_uris?: { art_crop?: string }; card_faces?: Array<{ image_uris?: { art_crop?: string } }> };
      const r = await getJson<{ data?: Card[]; has_more?: boolean }>(
        `https://api.scryfall.com/cards/search?${qs({ q: `year>=2021 -is:digital -t:basic -t:token -is:reprint`, unique: 'art', order: 'released', dir: 'desc', page: scryFrom + page })}`,
        signal,
      );
      const items: Cand[] = [];
      for (const c of recentFirst(r.data ?? [], (c) => Number(c.released_at?.slice(0, 4)) || 2021).slice(0, 60)) {
        const art = c.image_uris?.art_crop ?? c.card_faces?.[0]?.image_uris?.art_crop;
        if (!art) continue;
        items.push({ key: `scryfall:${c.id}`, src: 'scryfall', title: c.name, pos: items.length, thumb: art, full: art, page: c.scryfall_uri.split('?')[0], artist: c.artist, tags: words(c.name), aspect: 1.37, year: Number(c.released_at?.slice(0, 4)) || undefined });
      }
      return { items, more: !!r.has_more && page < 20 };
    },
  };
  const recentCards = (id: SourceId): Source => {
    let order: FeedRow[] | null = null;
    return {
      id,
      label: SOURCE_BY_ID[id].label,
      trust: T(1, 1, 1, 1, 1),
      local: true,
      sfw: true,
      async search(_p, page, signal) {
        if (signal.aborted) return none;
        order ??= recentFirst((await loadFeedRows()).filter((r) => r[0] === id), (r) => r[1]);
        const urls = CATALOG_URLS[id]!;
        const slice = order.slice(page * 20, (page + 1) * 20);
        // the catalog's index already holds each row's vector: no model work for these
        const vecs = await Promise.all(slice.map((r) => vectorOf(id, r[2]).catch(() => null)));
        const items = slice.map((r, i): Cand => {
          const row = r.slice(3) as CatRow;
          return { key: `${id}:${row[0]}`, src: id, title: row[1], pos: page * 20 + i, tags: [], vec: vecs[i] ?? undefined, year: r[1], ...urls(row) };
        });
        return { items, more: (page + 1) * 20 < order.length };
      },
    };
  };
  return [trending, newMtg, recentCards('lol'), recentCards('hearthstone'), recentCards('riftbound')];
}

export const SOURCES: Source[] = [
  poses,
  artstation,
  scryfall,
  openverse,
  wallhaven,
  safebooru,
  lol,
  riftbound,
  hearthstone,
  commons,
  inat,
  forgottenrealms,
  pathfinder,
  criticalrole,
  warhammer,
  elderscrolls,
  uesp,
  mtgwiki,
  lolwiki,
  dnd,
  met,
  cleveland,
  artsmia,
  europeana,
  ygo,
  lorcana,
  swu,
];
export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, Source>;
