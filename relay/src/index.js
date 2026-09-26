// Art Brief relay: passes a few image-search APIs that don't send CORS headers through to the
// web app, and small thumbnails from the two hosts wsrv.nl refuses (Wallhaven, Safebooru) so the
// ranking model can read them. Everything is cached at the edge.

const UA = 'ArtBriefRelay/1.0 (+https://kumikilongyeyo.github.io/art-brief/)';
const TTL = 1800;

const clamp = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// Each route turns validated query params into one upstream URL.
const ROUTES = {
  artstation: (p) => {
    const q = p.get('q');
    if (!q) return null;
    return `https://www.artstation.com/api/v2/search/projects.json?query=${encodeURIComponent(q)}&page=${clamp(p.get('page'), 1, 20, 1)}&per_page=${clamp(p.get('n'), 3, 50, 30)}`;
  },
  // the start screen's feed: what's trending in 2D illustration right now (no query)
  'artstation-feed': (p) =>
    `https://www.artstation.com/api/v2/community/explore/projects/trending.json?page=${clamp(p.get('page'), 1, 30, 1)}&dimension=2d&per_page=${clamp(p.get('n'), 10, 50, 30)}`,
  wallhaven: (p) => {
    const q = p.get('q');
    if (!q) return null;
    const purity = p.get('adult') === '1' ? '110' : '100'; // sfw (+ sketchy when adult is on); never nsfw
    return `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}&categories=110&purity=${purity}&sorting=relevance&page=${clamp(p.get('page'), 1, 20, 1)}`;
  },
  safebooru: (p) => {
    const tags = p.get('tags');
    if (!tags) return null;
    return `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${clamp(p.get('n'), 1, 60, 40)}&pid=${clamp(p.get('page'), 0, 20, 0)}&tags=${encodeURIComponent(tags)}`;
  },
  // Photo sites with keys (Worker secrets: `npx wrangler@4 secret put PEXELS_KEY` / `FLICKR_KEY`); the
  // keys stay here, never in the page. Without one the route answers "no results".
  pexels: (p, env) => {
    const q = p.get('q');
    if (!q) return null;
    if (!env.PEXELS_KEY) return { empty: '{"photos":[]}' };
    return {
      url: `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${clamp(p.get('n'), 5, 80, 30)}&page=${clamp(p.get('page'), 1, 20, 1)}`,
      headers: { Authorization: env.PEXELS_KEY },
    };
  },
  flickr: (p, env) => {
    const q = p.get('q');
    if (!q) return null;
    if (!env.FLICKR_KEY) return { empty: '{"photos":{"photo":[]}}' };
    // Creative Commons and public-domain photos only (licences 1–10), safe search on, photos not screenshots
    return `https://www.flickr.com/services/rest/?method=flickr.photos.search&api_key=${env.FLICKR_KEY}&text=${encodeURIComponent(q)}&sort=relevance&license=1,2,3,4,5,6,7,8,9,10&safe_search=1&content_type=1&media=photos&extras=url_z,url_b,owner_name,o_dims,tags&per_page=${clamp(p.get('n'), 5, 100, 30)}&page=${clamp(p.get('page'), 1, 20, 1)}&format=json&nojsoncallback=1`;
  },
  swu: (p) => {
    const q = p.get('q');
    if (!q) return null;
    return `https://api.swu-db.com/cards/search?q=${encodeURIComponent(q)}`;
  },
};

// Thumbnail passthrough for the sources' image hosts that don't send CORS headers: the ones wsrv.nl blocks,
// and the rest for when wsrv.nl refuses a visitor. Pictures only, up to MAX_IMG; cached a day.
const IMG_HOSTS = [
  'th.wallhaven.cc', 'safebooru.org',
  'art.hearthstonejson.com', 'cmsassets.rgpub.io', 'images.ygoprodeck.com', 'cards.lorcast.io', 'cdn.swu-db.com',
  'legendstory-production-s3-public.s3.amazonaws.com', // Flesh and Blood cards (no CORS)
  'static.wikia.nocookie.net', 'images.uesp.net', 'pathfinderwiki.com', 'hearthstone.wiki.gg',
  'images.metmuseum.org', 'openaccess-cdn.clevelandart.org', '1.api.artsmia.org', '4.api.artsmia.org',
  'api.europeana.eu', 'static.inaturalist.org',
];
const MAX_IMG = 6e6;

async function image(url, ctx, base) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return new Response('bad url', { status: 400, headers: base });
  }
  if (u.protocol !== 'https:' || !IMG_HOSTS.includes(u.hostname)) return new Response('host not allowed', { status: 403, headers: base });
  const cache = caches.default,
    key = new Request(u.toString());
  let res = await cache.match(key);
  if (!res) {
    const up = await fetch(u.toString(), { headers: { 'User-Agent': UA, Referer: `${u.origin}/` }, redirect: 'manual', cf: { cacheTtl: 86400 } });
    const type = up.headers.get('Content-Type') || '';
    if (!up.ok || !type.startsWith('image/') || +(up.headers.get('Content-Length') || 0) > MAX_IMG) return new Response('upstream refused', { status: 502, headers: base });
    res = new Response(up.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  const out = new Response(res.body, res);
  base.forEach((v, k) => out.headers.set(k, v));
  return out;
}

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const h = new Headers({ Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (origin && allowed.includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

// Per-visitor limit, so nobody can use the relay to hammer ArtStation or Wallhaven from this Worker's
// address (which would get it banned for everyone). Per isolate, which is plenty for one person's use.
const LIMIT = 600; // requests per minute per IP (a fast-scrolling session makes a few searches + many thumbnails)
const seen = new Map();
function limited(ip) {
  const now = Date.now(), w = seen.get(ip);
  if (!w || now - w.t > 60000) {
    seen.set(ip, { t: now, n: 1 });
    if (seen.size > 5000) seen.clear();
    return false;
  }
  return ++w.n > LIMIT;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const base = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: base });
    if (limited(request.headers.get('CF-Connecting-IP') || 'local')) return new Response('slow down', { status: 429, headers: base });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: base });

    const name = url.pathname.replace(/^\/+|\/+$/g, '');
    if (name === 'img') return image(url.searchParams.get('u') || '', ctx, base);
    if (name === '' || name === 'health') {
      base.set('Content-Type', 'application/json');
      return new Response(JSON.stringify({ ok: true, routes: [...Object.keys(ROUTES), 'img'] }), { headers: base });
    }
    const route = ROUTES[name];
    const r = route && route(url.searchParams, env);
    if (!r) return new Response('unknown route or missing query', { status: 400, headers: base });
    if (r.empty) {
      base.set('Content-Type', 'application/json');
      return new Response(r.empty, { headers: base });
    }
    const upstream = typeof r === 'string' ? r : r.url;
    const extra = typeof r === 'string' ? {} : r.headers;

    const cache = caches.default;
    const key = new Request(`https://relay.cache/${name}?${url.searchParams}`);
    let res = await cache.match(key);
    if (!res) {
      let up;
      try {
        up = await fetch(upstream, { headers: { 'User-Agent': UA, Accept: 'application/json', ...extra }, cf: { cacheTtl: TTL } });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'upstream unreachable', detail: String((e && e.message) || e) }), {
          status: 502,
          headers: base,
        });
      }
      const body = await up.text();
      const ok = up.ok && /^\s*[[{]/.test(body); // a bot-check page is HTML, not JSON
      res = new Response(ok ? body : JSON.stringify({ error: `upstream ${up.status}` }), {
        status: ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ok ? TTL : 60}` },
      });
      if (ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    base.forEach((v, k) => out.headers.set(k, v));
    return out;
  },
};
