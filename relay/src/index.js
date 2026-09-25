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
  swu: (p) => {
    const q = p.get('q');
    if (!q) return null;
    return `https://api.swu-db.com/cards/search?q=${encodeURIComponent(q)}`;
  },
};

// Thumbnail passthrough, only for hosts wsrv.nl blocks. Small images; cached a day.
const IMG_HOSTS = ['th.wallhaven.cc', 'safebooru.org'];

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
    const up = await fetch(u.toString(), { headers: { 'User-Agent': UA, Referer: `${u.origin}/` }, cf: { cacheTtl: 86400 } });
    const type = up.headers.get('Content-Type') || '';
    if (!up.ok || !type.startsWith('image/')) return new Response('upstream refused', { status: 502, headers: base });
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const base = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: base });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: base });

    const name = url.pathname.replace(/^\/+|\/+$/g, '');
    if (name === 'img') return image(url.searchParams.get('u') || '', ctx, base);
    if (name === '' || name === 'health') {
      base.set('Content-Type', 'application/json');
      return new Response(JSON.stringify({ ok: true, routes: [...Object.keys(ROUTES), 'img'] }), { headers: base });
    }
    const route = ROUTES[name];
    const upstream = route && route(url.searchParams);
    if (!upstream) return new Response('unknown route or missing query', { status: 400, headers: base });

    const cache = caches.default;
    const key = new Request(`https://relay.cache/${name}?${url.searchParams}`);
    let res = await cache.match(key);
    if (!res) {
      let up;
      try {
        up = await fetch(upstream, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: TTL } });
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
