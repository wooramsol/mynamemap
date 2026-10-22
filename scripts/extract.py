"""OSM PBF → 도로만 뽑은 압축 바이너리 (ways.bin)

사용: python3 scripts/extract.py south-korea-latest.osm.pbf data/ways.bin
형식: [uint32 way수] 반복{ uint32 n, n×(int64 nodeId, int32 lat*1e7, int32 lon*1e7) }
사이트의 '보행로 제외' 필터와 같은 기준을 쓴다.
"""
import struct
import sys

import osmium

EXCLUDE = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'proposed', 'construction', 'abandoned', 'platform',
    'elevator', 'corridor', 'steps', 'bus_stop', 'raceway', 'rest_area', 'services',
    'footway', 'path', 'cycleway', 'bridleway', 'track', 'pedestrian',
}


class Roads(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.count = 0

    def way(self, w):
        hw = w.tags.get('highway')
        if not hw or hw in EXCLUDE or w.tags.get('area') == 'yes':
            return
        if w.tags.get('footway') in ('sidewalk', 'crossing'):
            return
        pts = []
        for n in w.nodes:
            if not n.location.valid():
                continue
            pts.append((n.ref, int(round(n.location.lat * 1e7)), int(round(n.location.lon * 1e7))))
        if len(pts) < 2:
            return
        self.out.write(struct.pack('<I', len(pts)))
        for p in pts:
            self.out.write(struct.pack('<qii', *p))
        self.count += 1


def main(src, dst):
    with open(dst, 'wb') as f:
        f.write(struct.pack('<I', 0))
        h = Roads(f)
        h.apply_file(src, locations=True, idx='flex_mem')
        f.seek(0)
        f.write(struct.pack('<I', h.count))
    print('ways', h.count)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
