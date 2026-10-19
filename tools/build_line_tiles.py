"""
산길·물길 정적 타일(웹 앱 AR 선 표시용): 이름 없어도 모든 산길(path·track·footway·bridleway·steps)과 강·개울·계곡.
숲에 가려 안 보이는 길·물길을 화면에 선으로 그리기 위한 자료. 공개 Overpass가 자주 꽉 차서(502) 미리 만들어 둔다.

출력: lines/{la}_{lo}.json  (0.02° ≈ 2.2 km 격자)
  {"l": [[종류, 이름, 영어이름, [위도1, 경도1, Δ위도2, Δ경도2, ...]], ...]}  좌표는 1e-5° 정수(약 1 m), 둘째 점부터 앞 점과의 차이
  종류: t 등산로(이름 있는 산길·등산 경로), p 산길(이름 없음), r 강, s 개울·계곡물, v 계곡(지형)
사용: python build_line_tiles.py <south-korea-latest.osm.pbf> <출력 폴더(data)>
데이터: © OpenStreetMap contributors, ODbL 1.0
"""
import json
import math
import os
import sys
from collections import defaultdict

import osmium

STEP = 0.02
PATHS = ("path", "track", "footway", "bridleway", "steps")
BANNED = ("비법정", "출입금지", "통제", "폐쇄")


def simplify(pts, tol_m):
    if len(pts) < 3:
        return pts
    kx, ky = math.cos(math.radians(pts[0][0])) * 111320.0, 110540.0

    def dist(p, a, b):
        ax, ay, bx, by, px, py = a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky, p[1] * kx, p[0] * ky
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0, -1
        for k in range(i + 1, j):
            d = dist(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if best > tol_m:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


class Routes(osmium.SimpleHandler):
    """등산 경로(route=hiking) 구성 way → 경로 이름."""
    def __init__(self):
        super().__init__()
        self.name = {}

    def relation(self, r):
        if r.tags.get("route") != "hiking":
            return
        n = r.tags.get("name:ko") or r.tags.get("name")
        if not n:
            return
        for m in r.members:
            if m.type == "w":
                self.name.setdefault(m.ref, n)


class Ways(osmium.SimpleHandler):
    def __init__(self, route_name):
        super().__init__()
        self.route_name = route_name
        self.tiles = defaultdict(list)
        self.counts = defaultdict(int)

    def way(self, w):
        t = w.tags
        hw, ww, nat = t.get("highway"), t.get("waterway"), t.get("natural")
        name = t.get("name:ko") or t.get("name") or self.route_name.get(w.id) or ""
        if hw in PATHS:
            if t.get("access") in ("no", "private") or t.get("informal") == "yes":
                return
            if hw == "footway" and t.get("footway") in ("sidewalk", "crossing", "access_aisle"):
                return
            if name and any(b in name for b in BANNED):
                return
            kind = "t" if (name and not name[0].isdigit()) or w.id in self.route_name else "p"
            # 이름 없는 보도·계단은 대부분 도시 인도 → 빼고, 이름 없는 길은 산길(path·track·bridleway)만
            if kind == "p" and hw in ("footway", "steps"):
                return
            tol = 4.0 if kind == "t" else 6.0
        elif ww in ("river", "canal"):
            kind, tol = "r", 10.0
        elif ww == "stream":
            kind, tol = "s", 6.0
        elif nat == "valley":
            kind, tol = "v", 10.0
        else:
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if len(pts) < 2:
            return
        pts = simplify(pts, tol)
        flat, pa, pb = [], 0, 0
        for a, b in pts:
            ia, ib = round(a * 1e5), round(b * 1e5)
            flat += [ia - pa, ib - pb]
            pa, pb = ia, ib
        el = [kind, name, t.get("name:en") or "", flat]
        for k in {(math.floor(a / STEP), math.floor(b / STEP)) for a, b in pts}:
            self.tiles[k].append(el)
        self.counts[kind] += 1


def main():
    src, out = sys.argv[1], sys.argv[2]
    r = Routes()
    r.apply_file(src)
    w = Ways(r.name)
    w.apply_file(src, locations=True, idx="flex_mem")
    d = os.path.join(out, "lines")
    os.makedirs(d, exist_ok=True)
    total = 0
    for (la, lo), els in w.tiles.items():
        p = os.path.join(d, f"{la}_{lo}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"l": els}, f, ensure_ascii=False, separators=(",", ":"))
        total += os.path.getsize(p)
    meta_path = os.path.join(out, "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    meta.setdefault("counts", {})["lineWays"] = sum(w.counts.values())
    meta["counts"]["lineTiles"] = len(w.tiles)
    meta.setdefault("grid", {})["lines"] = STEP
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps({"ways": dict(w.counts), "tiles": len(w.tiles), "MB": round(total / 1e6, 1)}))


if __name__ == "__main__":
    main()
