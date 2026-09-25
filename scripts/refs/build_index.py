"""Pre-analyses the static card catalogs so the app can rank them instantly (no thumbnail fetches):

  public/refs/idx/<catalog>/centroids.bin   K cluster centres               (rows format)
  public/refs/idx/<catalog>/c<k>.bin        one cluster: row ids + vectors  (u32 n, u32 ids[n], rows)
  public/refs/idx/<catalog>/pose.bin        per row 52 bytes: MoveNet joints u8 [x, y, conf] × 17 (all 0 = no figure),
                                            then the image's width/height × 64 (u8), for aspect-correct angles
  public/refs/idx/<catalog>/rows.bin        u16 per row: which cluster holds it (65535 = image missing)
  public/refs/idx/<catalog>/meta.json       { n, k, dim, figures }

rows format = [n × f32 scale][n × 512 × i8], the same as the phrase-vector shards.
Uses the same weight-quantised models the browser runs, so offline and live vectors agree.

usage: python build_index.py [catalog ...]    (needs onnxruntime, numpy, pillow; ~15 min for all)
"""
import io, json, os, struct, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CAT = os.path.join(ROOT, 'public', 'refs', 'catalogs')
OUT = os.path.join(ROOT, 'public', 'refs', 'idx')
CACHE = os.environ.get('INDEX_CACHE', os.path.join(ROOT, '.cache', 'index-images'))
UA = {'User-Agent': 'ArtBriefIndex/1.0 (+https://kumikilongyeyo.github.io/art-brief/)'}
DIM = 512

RB = 'https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/'
URLS = {  # must match the thumbnails in src/refs/sources.ts
    'lol': lambda r: f"https://ddragon.leagueoflegends.com/cdn/img/champion/{'splash' if len(r) > 4 and r[4] == 'splash' else 'loading'}/{r[0]}.jpg",
    'hearthstone': lambda r: f'https://art.hearthstonejson.com/v1/256x/{r[0]}.jpg',
    'riftbound': lambda r: f'{RB}{r[4]}?w=400',
    'dnd': lambda r: f'https://www.dnd5eapi.co/api/images/monsters/{r[0]}.png',
    'poses': lambda r: f'https://upload.wikimedia.org/wikipedia/commons/{r[4]}',
}


def fetch(cat, row):
    path = os.path.join(CACHE, cat, row[0].replace('/', '_') + '.jpg')
    if os.path.exists(path):
        return path
    url = URLS[cat](row)
    for attempt in range(4):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()
            im = Image.open(io.BytesIO(data)).convert('RGB')
            im.thumbnail((480, 480), Image.BICUBIC)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            im.save(path, 'JPEG', quality=88)
            return path
        except Exception as e:  # noqa: BLE001 — network flakiness: retry, then give up on this row
            err = e
            time.sleep(1 + attempt)
    print('  failed', url, err)
    return None


def clip_input(im):
    # the browser's worker: shortest side to 256, centre crop
    w, h = im.size
    s = 256 / min(w, h)
    im = im.resize((max(256, round(w * s)), max(256, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 256) // 2, (h - 256) // 2
    return (np.asarray(im.crop((l, t, l + 256, t + 256)), dtype=np.float32) / 255.0).transpose(2, 0, 1)


def movenet_input(im):
    w, h = im.size
    s = 192 / max(w, h)
    nw, nh = round(w * s), round(h * s)
    canvas = Image.new('RGB', (192, 192))
    ox, oy = (192 - nw) // 2, (192 - nh) // 2
    canvas.paste(im.resize((nw, nh), Image.BICUBIC), (ox, oy))
    return np.asarray(canvas, dtype=np.int32)[None], (nw / 192, nh / 192, ox / 192, oy / 192)


def read_pose(mn, im):
    """MoveNet keypoints [x, y, score] × 17, x/y as fractions of the image. Two passes: the whole picture,
    then a square crop around the person it roughly found — a small figure in a wide photo is read
    far better once it fills the frame (about twice as many readable figures)."""
    def once(img):
        x, (sx, sy, ox, oy) = movenet_input(img)
        k = mn.run(None, {'input': x})[0][0, 0]  # [y, x, score] in the padded square
        return np.stack([np.clip((k[:, 1] - ox) / sx, 0, 1), np.clip((k[:, 0] - oy) / sy, 0, 1), k[:, 2]], 1)
    W, H = im.size
    a = once(im)
    seen = a[:, 2] > 0.1
    if seen.sum() < 4:
        return a
    xs, ys = a[seen, 0] * W, a[seen, 1] * H
    side = max(np.ptp(xs), np.ptp(ys)) * 1.5 + 20
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    x0, y0 = cx - side / 2, cy - side / 2
    if side >= max(W, H) * 0.9:
        return a  # the figure already fills the picture
    b = once(im.crop((round(x0), round(y0), round(x0 + side), round(y0 + side))))
    b[:, 0] = np.clip((x0 + b[:, 0] * side) / W, 0, 1)
    b[:, 1] = np.clip((y0 + b[:, 1] * side) / H, 0, 1)
    body = slice(5, 17)
    return b if (b[body, 2] > 0.3).sum() >= (a[body, 2] > 0.3).sum() else a


def rows_bytes(vecs):
    n = len(vecs)
    scale = np.abs(vecs).max(axis=1) / 127.0
    scale[scale == 0] = 1e-8
    q = np.clip(np.round(vecs / scale[:, None]), -127, 127).astype(np.int8)
    return scale.astype('<f4').tobytes() + q.tobytes()


def kmeans(x, k, iters=25, seed=0):
    rng = np.random.default_rng(seed)
    c = x[rng.choice(len(x), k, replace=False)].copy()
    for _ in range(iters):
        a = (x @ c.T).argmax(1)
        for j in range(k):
            m = x[a == j]
            if len(m):
                v = m.mean(0)
                c[j] = v / (np.linalg.norm(v) + 1e-9)
            else:
                c[j] = x[rng.integers(len(x))]
    return c, (x @ c.T).argmax(1)


def build(cat, clip, mn):
    rows = json.load(open(os.path.join(CAT, f'{cat}.json')))
    print(f'{cat}: {len(rows)} rows — downloading', flush=True)
    with ThreadPoolExecutor(24) as ex:
        paths = list(ex.map(lambda r: fetch(cat, r), rows))
    print(f'{cat}: embedding', flush=True)
    vecs = np.zeros((len(rows), DIM), np.float32)
    kps = np.zeros((len(rows), 52), np.uint8)
    figures = 0
    batch, idx = [], []

    def flush():
        if not batch:
            return
        e = clip.run(['image_embeds'], {'pixel_values': np.stack(batch)})[0]
        vecs[idx] = e / np.linalg.norm(e, axis=1, keepdims=True)
        batch.clear()
        idx.clear()

    for i, p in enumerate(paths):
        if not p:
            continue
        im = Image.open(p).convert('RGB')
        kps[i, 51] = min(255, round(im.size[0] / im.size[1] * 64))
        batch.append(clip_input(im))
        idx.append(i)
        if len(batch) == 32:
            flush()
        k = read_pose(mn, im)
        if (k[:, 2] > 0.3).sum() >= 8:
            figures += 1
            kps[i, :51] = np.stack([k[:, 0] * 255, k[:, 1] * 255, np.clip(k[:, 2], 0, 1) * 255], 1).round().astype(np.uint8).reshape(-1)
        if i % 1000 == 999:
            print(f'  {i + 1}/{len(rows)}', flush=True)
    flush()
    ok = np.linalg.norm(vecs, axis=1) > 0.5
    k = max(8, int(round(np.sqrt(ok.sum()) * 0.9)))
    cent, assign = kmeans(vecs[ok], k)
    ids_ok = np.nonzero(ok)[0]
    d = os.path.join(OUT, cat)
    os.makedirs(d, exist_ok=True)
    for f in os.listdir(d):
        os.remove(os.path.join(d, f))
    open(os.path.join(d, 'centroids.bin'), 'wb').write(rows_bytes(cent))
    for j in range(k):
        ids = ids_ok[assign == j].astype('<u4')
        open(os.path.join(d, f'c{j}.bin'), 'wb').write(struct.pack('<I', len(ids)) + ids.tobytes() + rows_bytes(vecs[ids]))
    open(os.path.join(d, 'pose.bin'), 'wb').write(kps.tobytes())
    where = np.full(len(rows), 65535, '<u2')  # row → its cluster (65535 = no image)
    where[ids_ok] = assign
    open(os.path.join(d, 'rows.bin'), 'wb').write(where.tobytes())
    json.dump({'n': len(rows), 'k': k, 'dim': DIM, 'figures': figures, 'missing': int((~ok).sum())}, open(os.path.join(d, 'meta.json'), 'w'))
    size = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
    print(f'{cat}: {ok.sum()} vectors, {k} clusters, {figures} figures, {size / 1e6:.2f} MB', flush=True)


if __name__ == '__main__':
    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.intra_op_num_threads = os.cpu_count() or 4
    clip = ort.InferenceSession(os.path.join(ROOT, 'public', 'models', 'mobileclip_s0_vision_w8.onnx'), so)
    mn = ort.InferenceSession(os.path.join(ROOT, 'public', 'models', 'movenet_lightning_w8.onnx'), so)
    for cat in sys.argv[1:] or list(URLS):
        build(cat, clip, mn)
