// 좌표·각도 계산. 지구는 구(반지름 6371 km)로 근사 — 수십 km 안에서 방향 오차 0.1° 미만.
export const R_EARTH = 6371008.8;
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const wrap360 = a => ((a % 360) + 360) % 360;
export const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dp = p2 - p1, dl = (lon2 - lon1) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 방위각(도, 북=0 시계방향). */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) * R2D);
}

/** 올려볼 각(도): 높이 차와 거리, 지구 곡률과 대기 굴절(k≈0.13)을 반영. */
export function elevationAngle(dist, dh, k = 0.13) {
  const drop = dist * dist / (2 * R_EARTH) * (1 - k);
  return Math.atan2(dh - drop, Math.max(dist, 1)) * R2D;
}

/** 기준점에서의 동·북 거리(m) — 수 km 안의 칼만 필터용 평면 근사. */
export function toEnu(lat0, lon0, lat, lon) {
  return [(lon - lon0) * D2R * R_EARTH * Math.cos(lat0 * D2R), (lat - lat0) * D2R * R_EARTH];
}
export function fromEnu(lat0, lon0, e, n) {
  return [lat0 + n / R_EARTH * R2D, lon0 + e / (R_EARTH * Math.cos(lat0 * D2R)) * R2D];
}

/** 방위·고도각 → 세계(ENU) 단위 벡터. */
export function dirFromAzEl(az, el) {
  const a = az * D2R, e = el * D2R;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

export function formatDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString()} km`;
}

const KO8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'], EN8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const bearingName = (az, en) => (en ? EN8 : KO8)[Math.round(wrap360(az) / 45) % 8];

/** 한국 부근 지오이드고(m) — GPS 타원체고 → 해발고. 그 밖은 0. */
export const geoid = (lat, lon) => (lat > 32 && lat < 40 && lon > 124 && lon < 132 ? 25 : 0);

/** 태양 위치(저정밀, ±0.1°): 고도·방위(도). NOAA 근사식. */
export function sunAltAz(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // J2000 기준 일수
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = wrap360(280.46061837 + 360.98564736629 * d);
  const ha = (gmst + lon) * D2R - ra;
  const p = lat * D2R;
  const alt = Math.asin(Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(p) - Math.sin(p) * Math.cos(ha));
  return { alt: alt * R2D, az: wrap360(az * R2D) };
}

/** 다음 해돋이·해넘이(36시간 안): 2분 간격 탐색 + 이분법, 기준 고도 −0.833°(굴절+반지름). */
export function nextSunEvent(from, lat, lon) {
  const h0 = -0.833, f = t => sunAltAz(new Date(t), lat, lon).alt - h0;
  let t = from.getTime(), prev = f(t);
  for (let i = 1; i <= 36 * 30; i++) {
    const t2 = from.getTime() + i * 120000, cur = f(t2);
    if ((prev < 0) !== (cur < 0)) {
      let a = t2 - 120000, b = t2;
      for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if ((f(a) < 0) !== (f(m) < 0)) b = m; else a = m; }
      const at = new Date((a + b) / 2);
      return { time: at, rise: prev < 0, az: sunAltAz(at, lat, lon).az };
    }
    prev = cur;
  }
  return null;
}
