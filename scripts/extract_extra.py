"""OSM에서 길·건물 말고 글자 획이 될 만한 선 뽑기 (ways.bin 형식)

사용: python3 scripts/extract_extra.py south-korea-latest.osm.pbf work/ways_extra.bin

- 철도 (땅 위만: 지하철 터널 제외)
- 개천·수로·도랑 중심선 (큰 강은 폭이 넓어 획처럼 안 보이므로 제외)
- 운동장 트랙, 원형 경기장 둘레 (ㅇ)
노드 ID는 OSM 그대로 쓴다 (길과 만나는 곳은 같은 노드라 이어짐).
"""
import struct
import sys

import osmium

RAIL = {'rail', 'light_rail', 'narrow_gauge', 'tram', 'subway', 'monorail'}
WATER = {'stream', 'canal', 'drain', 'ditch'}


class Extra(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.count = 0
        self.stats = {}

    def emit(self, w, kind):
        try:
            recs = [(n.ref, int(round(n.location.lat * 1e7)), int(round(n.location.lon * 1e7))) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(recs) < 2:
            return
        self.out.write(struct.pack('<I', len(recs)))
        for r in recs:
            self.out.write(struct.pack('<qii', *r))
        self.count += 1
        self.stats[kind] = self.stats.get(kind, 0) + 1

    def way(self, w):
        t = w.tags
        if t.get('railway') in RAIL and t.get('tunnel') in (None, 'no') and t.get('layer', '0')[:1] != '-':
            if t.get('railway') == 'subway' and t.get('bridge') in (None, 'no'):
                return  # 땅 위로 나온 지하철 구간만 (대부분 고가)
            return self.emit(w, 'rail')
        if t.get('waterway') in WATER and t.get('tunnel') in (None, 'no'):
            return self.emit(w, 'water')
        if t.get('leisure') == 'track' or (t.get('leisure') == 'stadium' and w.is_closed()):
            return self.emit(w, 'track')


def main(src, dst):
    with open(dst, 'wb') as f:
        f.write(struct.pack('<I', 0))
        h = Extra(f)
        h.apply_file(src, locations=True, idx='flex_mem')
        f.seek(0)
        f.write(struct.pack('<I', h.count))
    print('lines', h.count, h.stats)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
