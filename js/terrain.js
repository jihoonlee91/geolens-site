// 지형(DEM): AWS Terrain Tiles(terrarium PNG, 공개·무료, CORS 허용) z10 — 한 칸 약 120 m.
// 내 위치의 땅 높이와, 봉우리가 앞산에 가려지는지(시선이 지형에 막히는지) 판정에 쓴다.
// 내 주변 약 ±10 km는 z12(한 칸 약 30 m)로 더 촘촘하게 — 내 발밑 높이·가까운 능선 가림이 정확해짐.
const Z = 10, ZF = 12, N = 256;
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const tiles = new Map(); // "z/x/y" → Float32Array | 'loading' | 'fail'

const lon2x = (lon, z = Z) => (lon + 180) / 360 * (1 << z);
const lat2y = (lat, z = Z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z); };

async function load(x, y, z = Z) {
  const key = `${z}/${x}/${y}`;
  if (tiles.has(key)) return;
  tiles.set(key, 'loading');
  try {
    const res = await fetch(URL(z, x, y), { mode: 'cors' });
    if (!res.ok) throw new Error(res.status);
    const bmp = await createImageBitmap(await res.blob());
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), { width: N, height: N });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, N, N).data, h = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    tiles.set(key, h);
  } catch { tiles.set(key, 'fail'); }
}

/** 반경(m) 안 타일을 받는다. 끝나면 resolve. */
export async function ensureArea(lat, lon, radius) {
  const dLat = radius / 111000, dLon = radius / (111000 * Math.cos(lat * Math.PI / 180));
  const x0 = Math.floor(lon2x(lon - dLon)), x1 = Math.floor(lon2x(lon + dLon));
  const y0 = Math.floor(lat2y(lat + dLat)), y1 = Math.floor(lat2y(lat - dLat));
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(load(x, y));
  // 내 주변 z12 3×3
  const fx = Math.floor(lon2x(lon, ZF)), fy = Math.floor(lat2y(lat, ZF));
  for (let x = fx - 1; x <= fx + 1; x++) for (let y = fy - 1; y <= fy + 1; y++) jobs.push(load(x, y, ZF));
  await Promise.all(jobs);
}

export const loadedTiles = () => [...tiles.values()].filter(v => v instanceof Float32Array).length;

/** 해발 높이(m, 양선형 보간): 촘촘한 z12가 있으면 그것, 없으면 z10. 둘 다 없으면 NaN. */
export function elevation(lat, lon) {
  const v = sample(lat, lon, ZF);
  return Number.isNaN(v) ? sample(lat, lon, Z) : v;
}

function sample(lat, lon, z) {
  const fx = lon2x(lon, z), fy = lat2y(lat, z);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const h = tiles.get(`${z}/${tx}/${ty}`);
  if (!(h instanceof Float32Array)) return NaN;
  const px = (fx - tx) * N - 0.5, py = (fy - ty) * N - 0.5;
  const x0 = Math.max(0, Math.min(N - 1, Math.floor(px))), y0 = Math.max(0, Math.min(N - 1, Math.floor(py)));
  const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, px - x0)), ay = Math.max(0, Math.min(1, py - y0));
  const a = h[y0 * N + x0], b = h[y0 * N + x1], c = h[y1 * N + x0], d = h[y1 * N + x1];
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

/**
 * 능선 실루엣: 방위마다 바깥으로 걸어가며 올려볼 각이 새 최댓값이 되는 지점(보이는 땅)을 따라가고,
 * 그 뒤로 각이 내려가면 그 지점을 '능선 꼭대기'로 기록한다. 마지막 꼭대기가 하늘과 맞닿은 스카이라인.
 * 반환: 방위 a(도)마다 [{d, el}] (가까운 능선 → 먼 능선, 마지막이 스카이라인). 자료 없으면 빈 배열.
 */
export function skylineRay(oLat, oLon, oAlt, az, maxDist = 40000) {
  const R = 6371008.8, k = 0.13, D2R = Math.PI / 180, cosLat = Math.cos(oLat * D2R);
  const se = Math.sin(az * D2R), ce = Math.cos(az * D2R);
  const crests = [];
  let best = -90, prevEl = -90, prevD = 0, rising = false, any = false;
  for (let d = 60; d <= maxDist; d += Math.max(30, d * 0.012)) {
    const lat = oLat + d * ce / 111320, lon = oLon + d * se / (111320 * cosLat);
    const h = elevation(lat, lon);
    if (Number.isNaN(h)) { if (d > 2000 && any) break; continue; }
    any = true;
    const el = Math.atan2(h - d * d / (2 * R) * (1 - k) - oAlt, d) * 180 / Math.PI;
    if (el > best) { best = el; rising = true; }
    else if (rising && el < prevEl - 0.05) { // 보이던 오르막이 끝남 → 능선
      if (!crests.length || prevD - crests[crests.length - 1].d > 300) crests.push({ d: prevD, el: prevEl });
      rising = false;
    }
    prevEl = el; prevD = d;
  }
  if (rising && any) crests.push({ d: prevD, el: prevEl });
  return crests;
}

/**
 * 관측자 → 봉우리 시선이 지형에 막히는지. true(가림)/false(보임)/null(자료 없음).
 * 지구 곡률·굴절 반영, 봉우리 바로 앞 300 m와 내 발밑 150 m는 제외(격자 오차), 여유 12 m.
 */
export function occluded(oLat, oLon, oAlt, pLat, pLon, pAlt, dist) {
  const R = 6371008.8, k = 0.13;
  const steps = Math.min(400, Math.max(20, Math.round(dist / 100)));
  const pDrop = dist * dist / (2 * R) * (1 - k);
  let any = false;
  for (let i = 1; i < steps; i++) {
    const f = i / steps, s = dist * f;
    if (s < 150 || dist - s < 300) continue;
    const lat = oLat + (pLat - oLat) * f, lon = oLon + (pLon - oLon) * f;
    const g = elevation(lat, lon);
    if (Number.isNaN(g)) continue;
    any = true;
    const drop = s * s / (2 * R) * (1 - k);
    const ray = oAlt + (pAlt - pDrop - oAlt) * f;  // 곡률 보정한 시선 높이(봉우리 쪽 끝은 곡률만큼 낮게 보임)
    if (g - drop > ray + 12) return true;
  }
  return any ? false : null;
}
