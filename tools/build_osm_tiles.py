"""
OSM 국가 추출본(.osm.pbf) → 앱이 바로 읽는 정적 JSON 타일.
무료 정적 호스팅(GitHub Pages)에 올리면 공개 Overpass 서버 없이 빠르고 안정적으로 동작한다.

출력(Overpass JSON과 같은 모양이라 앱의 기존 파서를 그대로 사용):
  nature/{la}_{lo}.json       산봉우리·지형·폭포·호수·섬 (0.5° 격자 ≈ 55km, 40km 반경이면 최대 3×3장)
  sights/{la}_{lo}.json       유적·문화재·사찰·명소·랜드마크 (0.1° 격자 ≈ 11km)
  food/{la}_{lo}.json         음식점·카페 (0.02° 격자 ≈ 2km)
  meta.json                   생성 시각·개수·라이선스

사용: python build_osm_tiles.py <south-korea-latest.osm.pbf> <출력 폴더>
데이터 라이선스: © OpenStreetMap contributors, ODbL 1.0
"""
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

import osmium

KEEP = {
    "name", "name:ko", "name:en", "natural", "ele", "waterway", "historic", "heritage", "heritage:operator",
    "ref:kr:heritage", "tourism", "amenity", "religion", "man_made", "building", "height", "cuisine",
    "opening_hours", "phone", "contact:phone", "website", "contact:website", "wikipedia", "description",
    "description:ko", "start_date", "operator", "addr:full", "addr:city", "addr:street", "addr:housenumber", "place",
}
NATURE = {"peak", "volcano", "cape", "bay", "beach", "island", "islet", "cliff", "saddle", "ridge", "valley",
          "spring", "cave_entrance", "rock", "water"}
TOURISM = {"attraction", "viewpoint", "museum", "gallery", "zoo", "theme_park", "aquarium"}
MAN_MADE = {"tower", "lighthouse", "observatory", "bridge"}
FOOD = {"restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream"}
# 볼 가치가 있는 역사 유적만(동상·추모 명판·표지석 같은 작은 것은 제외 — 화면이 어지러워짐)
HISTORIC = {"castle", "fort", "city_gate", "citywalls", "palace", "archaeological_site", "ruins", "tomb", "monument",
            "building", "temple", "manor", "church", "monastery", "pagoda", "battlefield", "heritage", "tower", "bridge"}


def height_m(v):
    try:
        return float(str(v).replace("m", "").replace(",", ".").strip())
    except ValueError:
        return 0.0


def classify(t):
    if t.get("natural") in NATURE or t.get("place") in ("island", "islet") or t.get("waterway") == "waterfall":
        return "nature"
    if t.get("amenity") in FOOD:
        return "food"
    if "heritage" in t or t.get("historic") in HISTORIC:
        return "sights"
    if t.get("amenity") == "place_of_worship" and t.get("religion") == "buddhist":
        return "sights"
    if t.get("tourism") in TOURISM or t.get("man_made") in MAN_MADE:
        return "sights"
    if "building" in t and height_m(t.get("height", 0)) > 80:
        return "sights"
    return None


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nature = defaultdict(list)
        self.sights = defaultdict(list)
        self.food = defaultdict(list)

    def add(self, kind, typ, oid, lat, lon, tags):
        slim = {k: v for k, v in tags.items() if k in KEEP}
        el = {"type": typ, "id": oid, "tags": slim}
        lat, lon = round(lat, 6), round(lon, 6)
        if typ == "node":
            el["lat"], el["lon"] = lat, lon
        else:
            el["center"] = {"lat": lat, "lon": lon}
        if kind == "nature":
            self.nature[(math.floor(lat * 2), math.floor(lon * 2))].append(el)
        elif kind == "sights":
            self.sights[(math.floor(lat * 10), math.floor(lon * 10))].append(el)
        else:
            self.food[(math.floor(lat * 50), math.floor(lon * 50))].append(el)

    def node(self, n):
        if "name" not in n.tags:
            return
        tags = {t.k: t.v for t in n.tags}
        kind = classify(tags)
        if kind and n.location.valid():
            self.add(kind, "node", n.id, n.location.lat, n.location.lon, tags)

    def way(self, w):
        if "name" not in w.tags:
            return
        tags = {t.k: t.v for t in w.tags}
        kind = classify(tags)
        if not kind:
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
        lat = sum(p[0] for p in pts) / len(pts)
        lon = sum(p[1] for p in pts) / len(pts)
        self.add(kind, "way", w.id, lat, lon, tags)


def write(path, elements):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"elements": elements}, f, ensure_ascii=False, separators=(",", ":"))


def main():
    src, out = sys.argv[1], sys.argv[2]
    h = Handler()
    h.apply_file(src, locations=True, idx="flex_mem")
    for (la, lo), els in h.nature.items():
        write(os.path.join(out, "nature", f"{la}_{lo}.json"), els)
    for (la, lo), els in h.sights.items():
        write(os.path.join(out, "sights", f"{la}_{lo}.json"), els)
    for (la, lo), els in h.food.items():
        write(os.path.join(out, "food", f"{la}_{lo}.json"), els)
    meta = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": os.path.basename(src),
        "counts": {"nature": sum(map(len, h.nature.values())), "natureTiles": len(h.nature), "sights": sum(map(len, h.sights.values())), "food": sum(map(len, h.food.values())),
                   "sightsTiles": len(h.sights), "foodTiles": len(h.food)},
        "grid": {"nature": 0.5, "sights": 0.1, "food": 0.02},
        "license": "© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright",
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
