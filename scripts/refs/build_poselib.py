"""Builds the pose library: freely licensed Wikimedia Commons photos of people in clear, varied,
full-body poses, so stick-figure searches have real poses to match (MoveNet reads photos far more
reliably than painted card art).

Also takes Creative Commons Flickr photos found through Openverse (its API allows an anonymous visitor 200
searches a day, so at most OV_BUDGET are spent; the pictures come straight from Flickr).

Writes public/refs/catalogs/poses.json (rows: [id, title, words, artist, thumb]: a Commons path, or a full
URL for Flickr); then run
  python build_index.py poses
to add its vectors and joints.

usage: python build_poselib.py            search (once, cached), download, write the library
       python build_poselib.py --offline  write the library from what's already downloaded
Wikimedia rate-limits thumbnail downloads per IP, so downloading is slow (~30 a minute) and polite; it
takes photos round-robin across the queries, so a partial run still covers every pose.
"""
import io, json, os, re, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import onnxruntime as ort
from PIL import Image
from build_index import read_pose  # the same reading the index stores

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'refs', 'catalogs', 'poses.json')
CACHE = os.path.join(ROOT, '.cache', 'index-images', 'poses')
FOUND = os.path.join(ROOT, '.cache', 'poses-candidates.json')  # the searches, so a rerun only downloads
UA = {'User-Agent': 'ArtBriefPoseLibrary/1.0 (+https://kumikilongyeyo.github.io/art-brief/)'}
API = 'https://commons.wikimedia.org/w/api.php'
UPLOAD = 'https://upload.wikimedia.org/wikipedia/commons/'
THUMB_HOSTS = ('https://upload.wikimedia.org/wikipedia/commons/', 'https://thumb.wikimedia.org/wikipedia/commons/')

OV_API = 'https://api.openverse.org/v1/images/'
OV_FOUND = os.path.join(ROOT, '.cache', 'poses-openverse.json')
OV_BUDGET = int(os.environ.get('OV_BUDGET', '85'))  # Openverse searches this run may spend
# Poses as Flickr photographers title them (one page of 20 each)
OV_QUERIES = [
    'yoga pose', 'warrior pose yoga', 'tree pose yoga', 'ballet dancer leap', 'ballet pose', 'contemporary dance', 'hip hop dance',
    'breakdance freeze', 'flamenco dancer', 'dancer jumping', 'martial arts kick', 'karate kata', 'kung fu stance', 'tai chi',
    'capoeira', 'boxer punching', 'kickboxing', 'fencing lunge', 'sword fighting', 'larp fight', 'reenactment battle', 'archer drawing bow',
    'sprinter running', 'runner full body', 'long jump', 'high jump', 'hurdles', 'javelin throw', 'discus throw', 'shot put',
    'pole vault', 'gymnast', 'acrobat', 'cartwheel', 'handstand', 'backflip', 'splits stretch', 'cheerleader jump', 'figure skater',
    'parkour', 'skateboard trick', 'surfer riding wave', 'snowboard jump', 'rock climber', 'basketball layup', 'soccer kick',
    'tennis serve', 'baseball pitch', 'volleyball spike', 'kneeling', 'crouching', 'squat exercise', 'lunge exercise', 'push up',
    'sitting on the floor', 'sitting on steps', 'lying on the grass', 'jumping for joy', 'arms raised', 'reaching up', 'stretching arms',
    'walking on the street full body', 'fashion model full body', 'cosplay full body', 'cosplay sword pose', 'pointing', 'waving',
    'carrying a box', 'pulling a rope', 'throwing a ball', 'climbing a ladder', 'hanging from a bar', 'meditation pose', 'headstand',
]
# Poses artists ask for, phrased the way Commons files are titled and categorised.
QUERIES = [
    'fencing lunge', 'fencer attack', 'kendo match', 'kenjutsu', 'historical european martial arts', 'sword fighting reenactment',
    'karate kick', 'taekwondo kick', 'kickboxing', 'boxing punch', 'muay thai', 'capoeira', 'kung fu stance', 'judo throw', 'wrestling match',
    'sprinter running', 'marathon runner', 'hurdles athletics', 'long jump athlete', 'high jump athlete', 'javelin throw', 'discus throw',
    'shot put', 'pole vault', 'ballet dancer', 'ballet jump', 'contemporary dance', 'breakdance', 'flamenco dancer', 'gymnast floor exercise',
    'gymnastics balance beam', 'acrobat', 'parkour jump', 'yoga pose', 'stretching exercise', 'archery archer drawing bow', 'tennis serve',
    'baseball pitcher', 'cricket bowler', 'basketball dunk', 'volleyball spike', 'soccer kick', 'rock climbing', 'kneeling man', 'kneeling woman',
    'sitting on a chair portrait', 'crouching', 'squatting', 'lying on grass', 'actor stage fight',
    'cosplay sword', 'larp battle', 'medieval reenactment knight', 'samurai reenactment', 'soldier aiming rifle', 'throwing a ball', 'jumping in the air',
    'walking man full body', 'standing woman full body', 'skateboarder trick', 'surfer', 'skier jump', 'ice skater spin', 'trapeze artist', 'juggler',
    'arms raised', 'hands up celebration', 'cheering fans arms up', 'stretching arms overhead', 'sword raised overhead', 'axe swing',
    'reaching up', 'pointing', 'leaning on a wall', 'sitting on the ground', 'kneeling prayer', 'lunge exercise', 'push up exercise',
    'carrying a box', 'pulling a rope', 'climbing a ladder', 'dancing couple', 'backflip', 'cartwheel', 'handstand',
]
PER_QUERY = 45  # photos kept per query: enough variety, and a download that finishes


def api(params):
    for attempt in range(4):
        try:
            u = f'{API}?{urllib.parse.urlencode({**params, "format": "json"})}'
            return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40))
        except Exception:  # noqa: BLE001 — flaky network / rate limits: back off and retry
            time.sleep(2 + attempt * 3)
    return {}


def search(q):
    out = []
    for offset in (0, 50):
        r = api({'action': 'query', 'generator': 'search', 'gsrsearch': f'{q} filetype:bitmap', 'gsrnamespace': 6, 'gsrlimit': 50, 'gsroffset': offset,
                 'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata', 'iiextmetadatafilter': 'Artist|LicenseShortName', 'iiurlwidth': 480})
        for p in (r.get('query', {}).get('pages', {}) or {}).values():
            ii = (p.get('imageinfo') or [{}])[0]
            tu = ii.get('thumburl', '').split('?')[0]
            host = next((h for h in THUMB_HOSTS if tu.startswith(h)), None)
            if ii.get('mime') != 'image/jpeg' or ii.get('width', 0) < 400 or not host:
                continue
            artist = re.sub('<[^>]+>', '', (ii.get('extmetadata', {}).get('Artist', {}) or {}).get('value', '')).strip()[:60]
            out.append({'id': str(p['pageid']), 'title': re.sub(r'\.[a-z]+$', '', p['title'].replace('File:', ''), flags=re.I).replace('_', ' ')[:90],
                        'thumb': tu[len(host):], 'artist': artist, 'q': q})
        time.sleep(0.3)
    return out


# Wikimedia answers bursts of thumbnail requests with 429 + Retry-After: every worker waits it out
_pause = {'until': 0.0}
_lock = threading.Lock()
_done = {'n': 0}


def fetch(item):
    path = os.path.join(CACHE, item['id'] + '.jpg')
    if os.path.exists(path):
        return path
    for attempt in range(5):
        wait = _pause['until'] - time.time()
        if wait > 0:
            time.sleep(wait)
        try:
            src = item['thumb'] if item['thumb'].startswith('https://') else UPLOAD + item['thumb']
            data = urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=40).read()
            im = Image.open(io.BytesIO(data)).convert('RGB')
            os.makedirs(CACHE, exist_ok=True)
            im.save(path, 'JPEG', quality=88)
            with _lock:
                _done['n'] += 1
                if _done['n'] % 200 == 0:
                    print(f'  downloaded {_done["n"]}', flush=True)
            return path
        except urllib.error.HTTPError as e:
            if e.code == 429:
                with _lock:
                    _pause['until'] = max(_pause['until'], time.time() + float(e.headers.get('retry-after') or 10))
            elif e.code in (403, 404):
                return None
        except Exception:  # noqa: BLE001
            time.sleep(1 + attempt)
    return None


def ov_search(q):
    """One page of CC Flickr photos for q (Openverse), as 640px Flickr URLs."""
    for attempt in range(3):
        try:
            u = f'{OV_API}?{urllib.parse.urlencode({"q": q, "page_size": 20, "source": "flickr", "mature": "false"})}'
            d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429:
                return []
            time.sleep(float(e.headers.get('retry-after') or 60))
    else:
        return []
    out = []
    for x in d.get('results', []):
        m = re.match(r'(https://live\.staticflickr\.com/\d+/\d+_[0-9a-f]+)(?:_[a-z])?\.jpg$', x.get('url', ''))
        if m:
            out.append({'id': f"ov-{x['id']}", 'title': re.sub(r'\s+', ' ', x.get('title') or q)[:90], 'thumb': f'{m.group(1)}_z.jpg', 'artist': (x.get('creator') or '')[:60], 'q': q})
    return out


def full_body(mn, path):
    """True when MoveNet reads a figure head to feet (at least 10 of the 12 limb joints)."""
    k = read_pose(mn, Image.open(path).convert('RGB'))
    return (k[5:17, 2] > 0.3).sum() >= 10


if __name__ == '__main__':
    import sys
    offline = '--offline' in sys.argv
    found = json.load(open(FOUND)) if os.path.exists(FOUND) else {}
    if isinstance(found, list):  # older cache: one flat list
        by_q = {}
        for it in found:
            by_q.setdefault(it['q'], []).append(it)
        found = by_q
    for q in QUERIES:
        if q not in found and not offline:
            found[q] = search(q)
            print(f'{q}: {len(found[q])} candidates', flush=True)
            json.dump(found, open(FOUND, 'w'))
    ov = json.load(open(OV_FOUND)) if os.path.exists(OV_FOUND) else {}
    spent = 0
    for q in OV_QUERIES:
        if q in ov or offline or spent >= OV_BUDGET:
            continue
        ov[q] = ov_search(q)
        spent += 1
        print(f'openverse {q}: {len(ov[q])}', flush=True)
        json.dump(ov, open(OV_FOUND, 'w'))
        time.sleep(3.2)  # 20 a minute at most
    # round-robin across queries, so every pose is covered however far the download gets
    seen, items = set(), []
    lists = [found.get(q, [])[:PER_QUERY] for q in QUERIES] + [ov.get(q, []) for q in OV_QUERIES]
    for i in range(PER_QUERY):
        for lst in lists:
            if i < len(lst) and lst[i]['id'] not in seen:
                seen.add(lst[i]['id'])
                items.append(lst[i])
    print(f'{len(items)} photos to read', flush=True)
    if offline:
        paths = [p if os.path.exists(p) else None for p in (os.path.join(CACHE, it['id'] + '.jpg') for it in items)]
    else:
        with ThreadPoolExecutor(2) as ex:
            paths = list(ex.map(fetch, items))
    so = ort.SessionOptions()
    so.log_severity_level = 3
    mn = ort.InferenceSession(os.path.join(ROOT, 'public', 'models', 'movenet_lightning_w8.onnx'), so)
    rows = []
    for it, p in zip(items, paths):
        if p and full_body(mn, p):
            words = ' '.join(sorted(set(re.findall(r'[a-z]{3,}', (it['title'] + ' ' + it['q']).lower()))))
            rows.append([it['id'], it['title'], words, it['artist'], it['thumb']])
    json.dump(rows, open(OUT, 'w'))
    print(f'pose library: {len(rows)} full-body figures from {sum(1 for p in paths if p)} photos', flush=True)
