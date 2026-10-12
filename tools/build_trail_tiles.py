"""
등산로 정적 타일: 등산 경로(route=hiking) 구성 길 + 이름 있는 산길(path/track).
두 번 읽는다: ① 등산 경로 relation에서 구성 way와 경로 이름 수집 ② way 좌표를 단순화해 0.05° 격자 타일로 저장.
출력: trails/{la}_{lo}.json (Overpass "out geom"과 같은 모양 → 앱 파서 재사용)

사용: python build_trail_tiles.py <south-korea-latest.osm.pbf> <출력 폴더(data)>
데이터: © OpenStreetMap contributors, ODbL 1.0
"""
import json
import math
import os
import sys
from collections import defaultdict

import osmium

STEP = 0.05  # ≈ 5.5km 격자 — 반경 2.5km면 최대 2×2장
BANNED = ("비법정", "출입금지", "통제", "폐쇄")  # 안전: 출입이 금지된 길은 안내하지 않음


def bad_name(n):
    return not n or n[0].isdigit() or any(b in n for b in BANNED)


class Routes(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.way_route = {}  # way id → 경로 태그

    def relation(self, r):
        if r.tags.get("route") != "hiking":
            return
        name = r.tags.get("name:ko") or r.tags.get("name")
        if not name:
            return
        info = {"name": name, "route": "hiking"}
        for k in ("from", "to", "distance", "sac_scale", "operator"):
            if k in r.tags:
                info[k] = r.tags[k]
        for m in r.members:
            if m.type == "w" and m.ref not in self.way_route:
                self.way_route[m.ref] = info


def simplify(pts, tol_m=6.0):
    """Douglas–Peucker(평면 근사)로 점 수 줄이기."""
    if len(pts) < 3:
        return pts
    lat0 = pts[0][0]
    kx, ky = math.cos(math.radians(lat0)) * 111320.0, 110540.0

    def dist(p, a, b):
        ax, ay, bx, by = a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky
        px, py = p[1] * kx, p[0] * ky
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


class Ways(osmium.SimpleHandler):
    def __init__(self, way_route):
        super().__init__()
        self.way_route = way_route
        self.tiles = defaultdict(list)
        self.count = 0

    def way(self, w):
        route = self.way_route.get(w.id)
        hw = w.tags.get("highway")
        named_path = hw in ("path", "track") and ("name" in w.tags or "name:ko" in w.tags)
        if not route and not named_path:
            return
        if w.tags.get("access") in ("no", "private") or w.tags.get("informal") == "yes":
            return
        if bad_name((route or {}).get("name") or w.tags.get("name:ko") or w.tags.get("name")):
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if len(pts) < 2:
            return
        pts = simplify(pts)
        tags = dict(route) if route else {"name": w.tags.get("name:ko") or w.tags.get("name")}
        if hw:
            tags["highway"] = hw
        if "sac_scale" in w.tags and "sac_scale" not in tags:
            tags["sac_scale"] = w.tags["sac_scale"]
        el = {"type": "way", "id": w.id, "tags": tags, "geometry": [{"lat": round(a, 6), "lon": round(b, 6)} for a, b in pts]}
        keys = {(math.floor(a / STEP), math.floor(b / STEP)) for a, b in pts}
        for k in keys:
            self.tiles[k].append(el)
        self.count += 1


def main():
    src, out = sys.argv[1], sys.argv[2]
    r = Routes()
    r.apply_file(src)
    w = Ways(r.way_route)
    w.apply_file(src, locations=True, idx="flex_mem")
    d = os.path.join(out, "trails")
    os.makedirs(d, exist_ok=True)
    for (la, lo), els in w.tiles.items():
        with open(os.path.join(d, f"{la}_{lo}.json"), "w", encoding="utf-8") as f:
            json.dump({"elements": els}, f, ensure_ascii=False, separators=(",", ":"))
    meta_path = os.path.join(out, "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    meta.setdefault("counts", {})["trailWays"] = w.count
    meta["counts"]["trailTiles"] = len(w.tiles)
    meta.setdefault("grid", {})["trails"] = STEP
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps({"hikingRouteWays": len(r.way_route), "trailWays": w.count, "tiles": len(w.tiles)}))


if __name__ == "__main__":
    main()
