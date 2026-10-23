"""OSM 건물 윤곽 → 글자 '획'으로 쓸 수 있는 선 (ways.bin 과 같은 형식)

사용: python3 scripts/extract_buildings.py south-korea-latest.osm.pbf work/ways_bld.bin

위에서 보면 아파트 동은 'ㅡ자', 'ㄱ자', 'ㄷ자' 모양이 많다. 건물 하나를 획으로 바꾼다.
- 길쭉한 직사각형 건물 → 가운데 선 하나 (ㅡ·ㅣ 획)
- ㄱ·ㄷ·T자처럼 꺾인 큰 건물 → 래스터 뼈대(skeleton)를 선으로
- 둥근 건물(원형 경기장, 돔 등) → 윤곽 그대로 (ㅇ)
- 작은 집, 정사각형에 가까운 덩어리 건물 → 획이 아니므로 버림 (글자 주변을 지저분하게 만듦)
노드 ID는 음수로 새로 매긴다 (도로 노드와 겹치지 않게).
"""
import math
import struct
import sys

import numpy as np
import osmium
from shapely.geometry import Polygon
from shapely import affinity
from skimage.draw import polygon as fill_polygon
from skimage.morphology import skeletonize

MIN_AREA = 200        # m² 이보다 작은 건물(주택 등)은 버림
MIN_LEN = 25          # m 긴 변이 이보다 짧으면 버림
SLIM = 2.2            # 긴 변/짧은 변 이 이상이면 '획'
PIX = 1.5             # 뼈대 계산 해상도 (m)

next_id = [-1]


def new_id():
    next_id[0] -= 1
    return next_id[0]


def dp(points, eps):
    """Douglas-Peucker 단순화"""
    if len(points) < 3:
        return points
    a, b = np.array(points[0]), np.array(points[-1])
    ab = b - a
    L = np.hypot(*ab)
    best, bi = -1, -1
    for i in range(1, len(points) - 1):
        p = np.array(points[i])
        d = np.hypot(*(p - a)) if L < 1e-9 else abs(ab[0] * (p - a)[1] - ab[1] * (p - a)[0]) / L
        if d > best:
            best, bi = d, i
    if best <= eps:
        return [points[0], points[-1]]
    return dp(points[:bi + 1], eps)[:-1] + dp(points[bi:], eps)


def skeleton_lines(poly):
    """다각형 → 뼈대 선들 [(점들), ...], 교차점은 같은 좌표를 공유"""
    minx, miny, maxx, maxy = poly.bounds
    w, h = int((maxx - minx) / PIX) + 3, int((maxy - miny) / PIX) + 3
    if w * h > 400 * 400:
        return []
    xs, ys = poly.exterior.xy
    cols = (np.array(xs) - minx) / PIX + 1
    rows = (np.array(ys) - miny) / PIX + 1
    img = np.zeros((h, w), bool)
    rr, cc = fill_polygon(rows, cols, img.shape)
    img[rr, cc] = True
    for hole in poly.interiors:
        hx, hy = hole.xy
        rr, cc = fill_polygon((np.array(hy) - miny) / PIX + 1, (np.array(hx) - minx) / PIX + 1, img.shape)
        img[rr, cc] = False
    sk = skeletonize(img)
    pts = set(zip(*np.nonzero(sk)))
    if not pts:
        return []
    nb = lambda p: [(p[0] + dr, p[1] + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr or dc) and (p[0] + dr, p[1] + dc) in pts]
    deg = {p: len(nb(p)) for p in pts}
    nodes = {p for p in pts if deg[p] != 2}
    seen, lines = set(), []
    for s in nodes:
        for n in nb(s):
            if (s, n) in seen:
                continue
            path, prev, cur = [s, n], s, n
            seen.add((s, n)); seen.add((n, s))
            while cur not in nodes:
                nxt = [q for q in nb(cur) if q != prev and q not in path[-3:]]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                seen.add((prev, cur)); seen.add((cur, prev))
                path.append(cur)
            lines.append(path)
    if not lines and pts:  # 고리 하나뿐
        p0 = next(iter(pts)); lines = [[p0]]
    # 짧은 잔가지 제거 (끝이 막힌 짧은 선)
    out = []
    for L in lines:
        length = sum(math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]) for i in range(1, len(L))) * PIX
        dead = deg.get(L[0], 0) == 1 or deg.get(L[-1], 0) == 1
        if dead and length < 8:
            continue
        xy = [(minx + (c - 1) * PIX, miny + (r - 1) * PIX) for r, c in L]
        out.append(dp(xy, 2.0))
    return out


class Buildings(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out = out
        self.count = 0
        self.stats = {'slim': 0, 'skeleton': 0, 'round': 0, 'skip': 0}

    def emit(self, lines, to_ll):
        ids = {}
        for L in lines:
            if len(L) < 2:
                continue
            recs = []
            for x, y in L:
                key = (round(x, 1), round(y, 1))
                if key not in ids:
                    ids[key] = new_id()
                lat, lon = to_ll(x, y)
                recs.append((ids[key], int(round(lat * 1e7)), int(round(lon * 1e7))))
            self.out.write(struct.pack('<I', len(recs)))
            for r in recs:
                self.out.write(struct.pack('<qii', *r))
            self.count += 1

    def way(self, w):
        if 'building' not in w.tags or not w.is_closed() or len(w.nodes) < 4:
            return
        try:
            ll = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        lat0, lon0 = ll[0]
        kx, ky = math.cos(math.radians(lat0)) * 111320, 110540
        to_xy = lambda la, lo: ((lo - lon0) * kx, (la - lat0) * ky)
        to_ll = lambda x, y: (lat0 + y / ky, lon0 + x / kx)
        try:
            poly = Polygon([to_xy(*p) for p in ll]).buffer(0)
        except Exception:
            return
        if poly.is_empty or poly.geom_type != 'Polygon' or poly.area < MIN_AREA:
            self.stats['skip'] += 1
            return
        mrr = poly.minimum_rotated_rectangle
        c = list(mrr.exterior.coords)[:4]
        e1, e2 = math.dist(c[0], c[1]), math.dist(c[1], c[2])
        Lg, Sh = max(e1, e2), min(e1, e2)
        if Lg < MIN_LEN:
            self.stats['skip'] += 1
            return
        fill = poly.area / mrr.area
        circ = 4 * math.pi * poly.area / poly.length ** 2
        if circ > 0.85 and Lg >= 20:
            ring = list(poly.exterior.coords)
            self.emit([ring], to_ll); self.stats['round'] += 1
        elif fill >= 0.8 and Lg / max(Sh, 1e-6) >= SLIM:
            # 짧은 변의 가운데를 잇는 선
            if e1 < e2:
                a = ((c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2); b = ((c[2][0] + c[3][0]) / 2, (c[2][1] + c[3][1]) / 2)
            else:
                a = ((c[1][0] + c[2][0]) / 2, (c[1][1] + c[2][1]) / 2); b = ((c[3][0] + c[0][0]) / 2, (c[3][1] + c[0][1]) / 2)
            self.emit([[a, b]], to_ll); self.stats['slim'] += 1
        elif fill < 0.8 and poly.area >= 500:
            lines = skeleton_lines(poly)
            if lines:
                self.emit(lines, to_ll); self.stats['skeleton'] += 1
            else:
                self.stats['skip'] += 1
        else:
            self.stats['skip'] += 1


def main(src, dst):
    with open(dst, 'wb') as f:
        f.write(struct.pack('<I', 0))
        h = Buildings(f)
        h.apply_file(src, locations=True, idx='flex_mem')
        f.seek(0)
        f.write(struct.pack('<I', h.count))
    print('lines', h.count, h.stats)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
