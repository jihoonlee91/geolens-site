// 봉우리 말고 나머지: 산길·계곡·강(선), 전망대·랜드마크·절(점), 산 너머 마을·도시(점).
//  · 이름 있는 등산로: 정적 타일(data/trails, 0.05°)
//  · 가까운 오솔길·임도(이름 없어도)와 계곡·강·개울: 공개 Overpass(반경 1.5~3 km, 기기에 하루 캐시)
//  · 전망대·타워·높은 건물·절: 정적 타일(data/sights, 0.1°)
//  · 도시·읍·마을: Overpass(도시 60 km, 읍 30 km, 마을 8 km)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

async function cached(key, ttlMs, fn) {
  try { const c = JSON.parse(localStorage.getItem('geolens.cache.' + key) || 'null'); if (c && Date.now() - c.t < ttlMs) return c.v; } catch { }
  const v = await fn();
  try { localStorage.setItem('geolens.cache.' + key, JSON.stringify({ t: Date.now(), v })); } catch { /* 저장 공간 부족: 캐시 없이 */ }
  return v;
}

async function overpass(q) {
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (r.ok) return (await r.json()).elements || [];
    } catch { }
  }
  return null;
}

const snap = (v, s) => Math.round(v / s) * s;
const fx = v => v.toFixed(3);

const KINDS = { t: 'trail', p: 'path', r: 'river', s: 'stream', v: 'valley' };

/** 선: [{id, kind:'trail'|'path'|'river'|'stream'|'valley', name, pts:[[lat,lon],...]}]
 *  우선 우리 정적 타일(data/lines, 0.02°, 매월 OSM에서 생성) → 없으면 등산로 타일 + Overpass. */
export async function loadLines(dataUrl, version, lat, lon) {
  const step = 0.02, dLat = 2800 / 111000, dLon = 2800 / (111000 * Math.cos(lat * Math.PI / 180)), jobs = [];
  for (let a = Math.floor((lat - dLat) / step); a <= Math.floor((lat + dLat) / step); a++)
    for (let b = Math.floor((lon - dLon) / step); b <= Math.floor((lon + dLon) / step); b++)
      jobs.push(fetch(`${dataUrl}/lines/${a}_${b}.json?v=${encodeURIComponent(version)}`).then(r => (r.ok ? r.json() : r.status === 404 ? { l: [], missing: true } : null)).catch(() => null));
  const docs = await Promise.all(jobs);
  // 타일이 하나라도 있으면(이 지역 자료가 배포됨) 그것만 사용
  if (docs.some(d => d && !d.missing)) {
    const seen = new Map();
    for (const d of docs) for (const [k, name, en, f] of d?.l || []) {
      const id = `${k}${f[0]}_${f[1]}_${f.length}`;
      if (seen.has(id)) continue;
      const pts = []; let a = 0, b = 0; // 1e-5° 정수, 둘째 점부터 차이값
      for (let i = 0; i < f.length; i += 2) { a += f[i]; b += f[i + 1]; pts.push([a / 1e5, b / 1e5]); }
      seen.set(id, { id, kind: KINDS[k] || 'path', name, nameEn: en || undefined, pts });
    }
    return [...seen.values()];
  }
  return loadLinesFallback(dataUrl, version, lat, lon);
}

async function loadLinesFallback(dataUrl, version, lat, lon) {
  const out = new Map();
  // 1) 이름 있는 등산로 타일
  const step = 0.05, dLat = 3000 / 111000, dLon = 3000 / (111000 * Math.cos(lat * Math.PI / 180)), jobs = [];
  for (let a = Math.floor((lat - dLat) / step); a <= Math.floor((lat + dLat) / step); a++)
    for (let b = Math.floor((lon - dLon) / step); b <= Math.floor((lon + dLon) / step); b++)
      jobs.push(fetch(`${dataUrl}/trails/${a}_${b}.json?v=${encodeURIComponent(version)}`).then(r => (r.ok ? r.json() : { elements: [] })).catch(() => ({ elements: [] })));
  for (const d of await Promise.all(jobs)) for (const el of d.elements || []) {
    if (!el.geometry || el.geometry.length < 2) continue;
    out.set('w' + el.id, { id: 'w' + el.id, kind: 'trail', name: el.tags?.name || '', pts: el.geometry.map(p => [p.lat, p.lon]) });
  }
  // 2) 가까운 길(이름 없어도)·물길 — Overpass
  const sLat = snap(lat, 0.005), sLon = snap(lon, 0.005);
  const els = await cached(`lines:${fx(sLat)},${fx(sLon)}`, 86400000, async () => {
    const q = `[out:json][timeout:25];(way["highway"~"^(path|track|footway|steps|bridleway)$"](around:1500,${sLat},${sLon});` +
      `way["waterway"~"^(river|stream|canal)$"](around:3000,${sLat},${sLon});way["natural"="valley"](around:3000,${sLat},${sLon}););out tags geom qt;`;
    const r = await overpass(q);
    return r ? r.filter(e => e.geometry).map(e => ({ id: e.id, t: e.tags || {}, g: e.geometry.map(p => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) })) : null;
  });
  for (const e of els || []) {
    if (out.has('w' + e.id)) continue;
    const t = e.t, kind = t.waterway === 'river' || t.waterway === 'canal' ? 'river' : t.waterway === 'stream' ? 'stream' : t.natural === 'valley' ? 'valley' : 'path';
    out.set('w' + e.id, { id: 'w' + e.id, kind, name: t['name:ko'] || t.name || '', nameEn: t['name:en'], pts: e.g });
  }
  return [...out.values()];
}

/** 전망대·타워·높은 건물·절: [{id, kind, name, lat, lon, height}] (반경 6 km) */
export async function loadSights(dataUrl, version, lat, lon) {
  const step = 0.1, dLat = 6000 / 111000, dLon = 6000 / (111000 * Math.cos(lat * Math.PI / 180)), jobs = [];
  for (let a = Math.floor((lat - dLat) / step); a <= Math.floor((lat + dLat) / step); a++)
    for (let b = Math.floor((lon - dLon) / step); b <= Math.floor((lon + dLon) / step); b++)
      jobs.push(fetch(`${dataUrl}/sights/${a}_${b}.json?v=${encodeURIComponent(version)}`).then(r => (r.ok ? r.json() : { elements: [] })).catch(() => ({ elements: [] })));
  const out = [];
  for (const d of await Promise.all(jobs)) for (const el of d.elements || []) {
    const t = el.tags || {}, name = t['name:ko'] || t.name; if (!name) continue;
    const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon; if (la == null) continue;
    const h = parseFloat(t.height || t['building:height'] || '');
    let kind = null;
    if (t.tourism === 'viewpoint') kind = 'viewpoint';
    else if (t.man_made === 'tower' || t.man_made === 'observatory' || t.man_made === 'lighthouse') kind = 'tower';
    else if (t.building && h >= 150 && !/^(apartments|residential|house|dormitory)$/.test(t.building) && !/\d+동$|[A-Za-z가-힣]동$/.test(name)) kind = 'building'; // 아파트 동은 빼고 진짜 랜드마크만
    else if (t.amenity === 'place_of_worship' && t.religion === 'buddhist') kind = 'temple';
    else if (t.historic === 'castle' || t.historic === 'citywalls' || t.historic === 'city_gate') kind = 'heritage';
    if (!kind) continue;
    out.push({ id: `osm:${el.type}/${el.id}`, kind, name, nameEn: t['name:en'], lat: la, lon: lo, height: Number.isFinite(h) ? h : NaN, ele: parseFloat(t.ele || '') });
  }
  return out;
}

/** 산 너머 도시·읍·마을: [{id, kind:'city'|'town'|'village', name, lat, lon}] */
export async function loadPlaces(lat, lon) {
  const sLat = snap(lat, 0.05), sLon = snap(lon, 0.05);
  const els = await cached(`places:${sLat.toFixed(2)},${sLon.toFixed(2)}`, 7 * 86400000, async () => {
    const q = `[out:json][timeout:25];(node["place"="city"](around:60000,${sLat},${sLon});node["place"="town"](around:30000,${sLat},${sLon});` +
      `node["place"="village"](around:8000,${sLat},${sLon}););out tags qt;`;
    const r = await overpass(q);
    return r ? r.map(e => ({ id: 'osm:node/' + e.id, kind: e.tags.place, name: e.tags['name:ko'] || e.tags.name, nameEn: e.tags['name:en'], lat: e.lat, lon: e.lon })).filter(p => p.name) : null;
  });
  return els || [];
}
