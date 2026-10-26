"""눈으로 검토해 통과한 후보만으로 사이트 data/ 만들기

사용: python3 build.py out_dir pool1.jsonl:approved1.txt [pool2.jsonl:approved2.txt ...]
- approvedN.txt: 통과한 후보 번호(id)를 쉼표/줄바꿈으로 나열
- 음절마다 통과한 후보를 점수순으로 최대 3곳 (300m 안 중복은 하나만)
"""
import json, math, os, sys, datetime
out, specs = sys.argv[1], sys.argv[2:]
by = {}
for spec in specs:
    pool, appr = spec.split(':')
    ids = {int(x) for x in open(appr).read().replace('\n', ',').split(',') if x.strip()}
    for l in open(pool):
        r = json.loads(l)
        if r['id'] in ids:
            by.setdefault(r['c'], []).append(r['rec'])
far = lambda a, b: math.hypot((a['lat'] - b['lat']) * 110540, (a['lon'] - b['lon']) * 88000) >= 300
shards = [{} for _ in range(19)]
for c, L in by.items():
    L.sort(key=lambda x: -x['s'])
    keep = []
    for x in L:
        if all(far(x, y) for y in keep):
            keep.append(x)
        if len(keep) == 3: break
    shards[(ord(c) - 0xAC00) // 588][c] = keep
os.makedirs(out + '/syl', exist_ok=True)
for i, sh in enumerate(shards):
    json.dump(sh, open(f'{out}/syl/{i}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
json.dump({'built': datetime.date.today().isoformat(), 'syllables': len(by), 'reviewed': True}, open(out + '/meta.json', 'w'))
print('syllables', len(by))
