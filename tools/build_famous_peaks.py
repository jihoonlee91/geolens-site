"""
100대 명산 목록(famous_peaks.csv)을 OSM 봉우리(data/nature/*.json)에 맞춰 앱용 data/collections/famous.json을 만든다.

사용: python build_famous_peaks.py <famous_peaks.csv> <data 폴더>
  - 이름(별칭 포함)이 맞고 높이가 비슷한 OSM 봉우리 중 해당 도(道) 중심에 가까운 것을 고른다.
  - 못 찾으면 경고를 출력하고 건너뛴다(앱은 있는 것만 표시) → CSV의 alts/ele를 고쳐 다시 실행.
출력 형식:
  {"generated": ..., "lists": {"forest100": {...}, "bac100": {...}},
   "peaks": [{"key","name","summit","ele","lat","lon","id","lists":[...],"note"}]}
"""
import csv
import glob
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

LISTS = {
    "forest100": {"title": "산림청 100대 명산", "titleEn": "Korea Forest Service 100"},
    "bac100": {"title": "블랙야크 명산100", "titleEn": "Black Yak 100 (BAC)"},
}
# 도(道) 대략 중심 — 같은 이름·비슷한 높이가 여럿일 때 가까운 쪽
PROV = {
    "서울": (37.57, 126.98), "인천": (37.45, 126.70), "경기": (37.40, 127.20), "강원": (37.80, 128.20),
    "충북": (36.80, 127.70), "충남": (36.50, 126.90), "대전": (36.35, 127.38), "세종": (36.50, 127.25),
    "전북": (35.80, 127.10), "전남": (34.90, 126.90), "광주": (35.16, 126.85),
    "경북": (36.40, 128.70), "대구": (35.87, 128.60), "경남": (35.40, 128.20), "부산": (35.18, 129.07), "울산": (35.54, 129.31),
    "제주": (33.40, 126.55),
}


def norm(s):
    return re.sub(r"[\s()\[\]·,.\-_/]", "", s or "")


def dist_km(a, b, c, d):
    p = math.pi / 180
    x = math.cos(a * p) * math.cos(c * p) * math.cos((d - b) * p) + math.sin(a * p) * math.sin(c * p)
    return 6371 * math.acos(max(-1, min(1, x)))


def load_peaks(data_dir):
    peaks = []
    for path in glob.glob(os.path.join(data_dir, "nature", "*.json")):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for el in doc.get("elements", []):
            tags = el.get("tags") or {}
            if tags.get("natural") != "peak":
                continue
            lat = el.get("lat", (el.get("center") or {}).get("lat"))
            lon = el.get("lon", (el.get("center") or {}).get("lon"))
            if lat is None or lon is None:
                continue
            name = tags.get("name") or tags.get("name:ko") or ""
            if not name:
                continue
            ele = None
            m = re.search(r"-?\d+(\.\d+)?", str(tags.get("ele", "")))
            if m:
                ele = float(m.group(0))
            peaks.append({"id": f"osm:{el.get('type')}/{el.get('id')}", "name": name, "alt": tags.get("alt_name") or "",
                          "lat": lat, "lon": lon, "ele": ele})
    return peaks


def resolve(row, peaks):
    alts = [norm(a) for a in (row["alts"] or row["name"]).split("|") if a.strip()]
    ele = float(row["ele"]) if row["ele"] else None
    pc = PROV.get(row["prov"].strip())
    # 같은 이름·비슷한 높이가 다른 곳에도 있으면(깃대봉·수리봉·성인봉) CSV에 lat,lon 힌트 → 8km 안에서만
    hint = (float(row["lat"]), float(row["lon"])) if row.get("lat") and row.get("lon") else None
    best, best_score = None, None
    for p in peaks:
        n = norm(p["name"]) + "|" + norm(p["alt"])
        if not any(a and (a in n) for a in alts):
            continue
        score = 0.0
        if ele is not None and p["ele"] is not None:
            de = abs(p["ele"] - ele)
            if de > 120:
                continue
            score += de
        else:
            score += 60  # 높이 모름
        if hint:
            d = dist_km(hint[0], hint[1], p["lat"], p["lon"])
            if d > 8:
                continue
            score += d * 5
        elif pc:
            d = dist_km(pc[0], pc[1], p["lat"], p["lon"])
            if d > 220:
                continue
            score += d / 4
        # 봉우리 이름이 정상 이름과 정확히 같으면 가산점
        if norm(row["summit"]) and norm(row["summit"]) in n:
            score -= 15
        if best is None or score < best_score:
            best, best_score = p, score
    return best


def main():
    src, data = sys.argv[1], sys.argv[2]
    peaks = load_peaks(data)
    print(f"OSM 봉우리 {len(peaks)}개")
    out, missing = [], []
    with open(src, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            p = resolve(row, peaks)
            if p is None:
                missing.append(f"{row['key']} {row['name']} {row['summit']} {row['ele']} {row['prov']}")
                continue
            out.append({
                "key": row["key"], "name": row["name"], "summit": row["summit"], "ele": float(row["ele"]) if row["ele"] else p["ele"],
                "lat": round(p["lat"], 5), "lon": round(p["lon"], 5), "id": p["id"], "osmName": p["name"],
                "lists": [x for x in row["lists"].split("|") if x], "note": row.get("note") or "",
            })
    counts = {k: sum(1 for o in out if k in o["lists"]) for k in LISTS}
    doc = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lists": {k: dict(v, count=counts[k]) for k, v in LISTS.items()},
        "peaks": out,
    }
    os.makedirs(os.path.join(data, "collections"), exist_ok=True)
    with open(os.path.join(data, "collections", "famous.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"맞춘 봉우리 {len(out)}개: " + ", ".join(f"{k} {c}" for k, c in counts.items()))
    if missing:
        print("못 찾음:\n  " + "\n  ".join(missing))
    # 같은 OSM 봉우리에 두 항목이 붙으면 오류
    seen = {}
    for o in out:
        if o["id"] in seen:
            print(f"경고: {o['key']}와 {seen[o['id']]}가 같은 봉우리 {o['id']}({o['osmName']})")
        seen[o["id"]] = o["key"]


if __name__ == "__main__":
    main()
