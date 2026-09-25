"""Builds the pose library: freely licensed Wikimedia Commons photos of people in clear, varied,
full-body poses, so stick-figure searches have real poses to match (MoveNet reads photos far more
reliably than painted card art).

Writes public/refs/catalogs/poses.json (rows: [id, title, words, artist, thumb-path]); then run
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

# Poses artists ask for, phrased the way Commons files are titled and categorised.
QUERIES = [
    'fencing lunge', 'fencer attack', 'kendo match', 'kenjutsu', 'historical european martial arts', 'sword fighting reenactment',
    'karate kick', 'taekwondo kick', 'kickboxing', 'boxing punch', 'muay thai', 'capoeira', 'kung fu stance', 'judo throw', 'wrestling match',
    'sprinter running', 'marathon runner', 'hurdles athletics', 'long jump athlete', 'high jump athlete', 'javelin throw', 'discus throw',
    'shot put', 'pole vault', 'ballet dancer', 'ballet jump', 'contemporary dance', 'breakdance', 'flamenco dancer', 'gymnast floor exercise',
    'gymnastics balance beam', 'acrobat', 'parkour jump', 'yoga pose', 'stretching exercise', 'archery archer drawing bow', 'tennis serve',
    'baseball pitcher', 'cricket bowler', 'basketball dunk', 'volleyball spike', 'soccer kick', 'rock climbing', 'kneeling man', 'kneeling woman',
    'sitting on a chair portrait', 'crouching', 'squatting', 'lying on grass', 'figure drawing model pose', 'life drawing pose', 'actor stage fight',
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
            data = urllib.request.urlopen(urllib.request.Request(UPLOAD + item['thumb'], headers=UA), timeout=40).read()
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
    # round-robin across queries, so every pose is covered however far the download gets
    seen, items = set(), []
    lists = [found.get(q, [])[:PER_QUERY] for q in QUERIES]
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
