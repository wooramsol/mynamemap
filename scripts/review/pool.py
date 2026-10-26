# 검토 후보 모으기: python3 pool.py out.jsonl glyphfile:min[,..] composeDir:min
import json, sys, glob, math, os
out, gspec, cspec = sys.argv[1:4]
KSX = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ksx1001.txt')).read().strip()
ks = set(KSX)
cand = {}
def add(c, x):
    if c in ks: cand.setdefault(c, []).append(x)
for spec in gspec.split(','):
    f, mn = spec.split(':'); mn = float(mn)
    for l in open(f):
        o = json.loads(l)
        if o['s'] < mn: continue
        add(o['c'], dict(m='g', s=o['s'], lat=o['lat'], lon=o['lon'], r=o['r'], size=o['size'], g=o['g'],
                         rec={'s': o['s'], 'lat': o['lat'], 'lon': o['lon'], 'r': o['r'], 'size': o['size'], 'm': 'g',
                              'parts': [{'j': o['c'], 's': o['s'], 'r': o['r'], 'lat': o['lat'], 'lon': o['lon'], 'g': o['g']}]}))
cdir, cmin = cspec.split(':'); cmin = float(cmin)
for f in glob.glob(cdir + '/syl/*.json'):
    for c, L in json.load(open(f)).items():
        for x in L:
            if x.get('k') == 'c' or x['s'] < cmin: continue
            g = [seg for p in x['parts'] for seg in p['g']]
            add(c, dict(m='j', s=x['s'], lat=x['lat'], lon=x['lon'], r=x['r'], size=x['size'], g=g, rec={**x, 'm': 'j'}))
far = lambda a, b: math.hypot((a['lat'] - b['lat']) * 110540, (a['lon'] - b['lon']) * 88000) >= 300
rows = []
for c in KSX:
    L = sorted(cand.get(c, []), key=lambda x: -x['s'])
    pick = []
    for m, k in (('g', 3), ('j', 2)):
        n = 0
        for x in L:
            if x['m'] != m or n >= k: continue
            if all(far(x, y) for y in pick): pick.append(x); n += 1
    for x in pick: rows.append({'c': c, **x})
with open(out, 'w') as f:
    for i, r in enumerate(rows):
        r['id'] = i; f.write(json.dumps(r, ensure_ascii=False) + '\n')
print('rows', len(rows), 'syllables', len({r['c'] for r in rows}))
