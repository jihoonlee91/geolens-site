"""
건물 스카이라인 타일: 높이(height) 또는 층수(building:levels)가 있는 20 m 이상 건물의 중심·높이·반지름.
앱이 도시 스카이라인을 그리고, 건물에 가려진 산을 숨기는 데 쓴다.

출력: buildings/{la}_{lo}.json  (0.02° 격자)
  {"b": [위도오프셋, 경도오프셋, 높이m, 반지름m, ...]}  오프셋 = (좌표 - 격자 모서리) × 1e5 정수
사용: python build_building_tiles.py <south-korea-latest.osm.pbf> <출력 폴더(data)>
데이터: © OpenStreetMap contributors, ODbL 1.0
"""
import json
import math
import os
import re
import sys
from collections import defaultdict

import osmium

STEP = 0.02
MIN_H = 20.0


def height_of(tags):
    h = tags.get("height") or tags.get("building:height")
    if h:
        m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)", h)
        if m:
            return float(m.group(1))
    lv = tags.get("building:levels")
    if lv:
        m = re.match(r"\s*([0-9]+)", lv)
        if m:
            return int(m.group(1)) * 3.2 + 2
    return None


class Buildings(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.tiles = defaultdict(list)
        self.count = 0

    def area(self, a):
        t = a.tags
        if "building" not in t and "building:part" not in t:
            return
        h = height_of(t)
        if h is None or h < MIN_H or h > 700:
            return
        pts = []
        try:
            for ring in a.outer_rings():
                pts += [(n.lat, n.lon) for n in ring if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 3:
            return
        clat = sum(p[0] for p in pts) / len(pts)
        clon = sum(p[1] for p in pts) / len(pts)
        kx = math.cos(math.radians(clat)) * 111320.0
        r = max(math.hypot((p[0] - clat) * 110540.0, (p[1] - clon) * kx) for p in pts)
        r = min(max(r, 5.0), 250.0)
        la, lo = math.floor(clat / STEP), math.floor(clon / STEP)
        self.tiles[(la, lo)] += [round((clat - la * STEP) * 1e5), round((clon - lo * STEP) * 1e5), round(h), round(r)]
        self.count += 1


def main():
    src, out = sys.argv[1], sys.argv[2]
    b = Buildings()
    b.apply_file(src, locations=True, idx="flex_mem")
    d = os.path.join(out, "buildings")
    os.makedirs(d, exist_ok=True)
    total = 0
    for (la, lo), arr in b.tiles.items():
        p = os.path.join(d, f"{la}_{lo}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"b": arr}, f, separators=(",", ":"))
        total += os.path.getsize(p)
    meta_path = os.path.join(out, "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8")) if os.path.exists(meta_path) else {}
    meta.setdefault("counts", {})["buildings"] = b.count
    meta["counts"]["buildingTiles"] = len(b.tiles)
    meta.setdefault("grid", {})["buildings"] = STEP
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps({"buildings": b.count, "tiles": len(b.tiles), "MB": round(total / 1e6, 1)}))


if __name__ == "__main__":
    main()
