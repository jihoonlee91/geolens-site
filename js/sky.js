// 해·달 위치와 하루 경로. 달은 Schlyter 근사(주요 섭동 포함, 오차 수 분각) + 지표면 시차 보정(지평선 근처 최대 1°).
import { sunAltAz } from './geo.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const rev = x => ((x % 360) + 360) % 360;
const sind = x => Math.sin(x * D2R), cosd = x => Math.cos(x * D2R);

/** 달: 고도·방위(도), 거리(km), 밝은 면 비율(0~1), 차오르는지. */
export function moonAltAz(date, lat, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451543.5; // Schlyter 기준일(1999-12-31 0h)
  const N = rev(125.1228 - 0.0529538083 * d), i = 5.1454, w = rev(318.0634 + 0.1643573223 * d);
  const a = 60.2666, e = 0.0549, M = rev(115.3654 + 13.0649929509 * d);
  let E = M + R2D * e * sind(M) * (1 + e * cosd(M));
  for (let k = 0; k < 5; k++) E = E - (E - R2D * e * sind(E) - M) / (1 - e * cosd(E));
  const xv = a * (cosd(E) - e), yv = a * Math.sqrt(1 - e * e) * sind(E);
  const v = rev(Math.atan2(yv, xv) * R2D); let r = Math.hypot(xv, yv);
  const xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  const yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  const zh = r * sind(v + w) * sind(i);
  let lonE = rev(Math.atan2(yh, xh) * R2D), latE = Math.atan2(zh, Math.hypot(xh, yh)) * R2D;
  // 섭동(해의 영향)
  const Ms = rev(356.0470 + 0.9856002585 * d), ws = 282.9404 + 4.70935e-5 * d, Ls = rev(Ms + ws);
  const Lm = rev(N + w + M), D = rev(Lm - Ls), F = rev(Lm - N);
  lonE += -1.274 * sind(M - 2 * D) + 0.658 * sind(2 * D) - 0.186 * sind(Ms) - 0.059 * sind(2 * M - 2 * D) - 0.057 * sind(M - 2 * D + Ms)
    + 0.053 * sind(M + 2 * D) + 0.046 * sind(2 * D - Ms) + 0.041 * sind(M - Ms) - 0.035 * sind(D) - 0.031 * sind(M + Ms) - 0.015 * sind(2 * F - 2 * D) + 0.011 * sind(M - 4 * D);
  latE += -0.173 * sind(F - 2 * D) - 0.055 * sind(M - F - 2 * D) - 0.046 * sind(M + F - 2 * D) + 0.033 * sind(F + 2 * D) + 0.017 * sind(2 * M + F);
  r += -0.58 * cosd(M - 2 * D) - 0.46 * cosd(2 * D);
  // 황도 → 적도 → 지평
  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = cosd(lonE) * cosd(latE), ye = sind(lonE) * cosd(latE) * cosd(ecl) - sind(latE) * sind(ecl), ze = sind(lonE) * cosd(latE) * sind(ecl) + sind(latE) * cosd(ecl);
  const ra = Math.atan2(ye, xe) * R2D, dec = Math.atan2(ze, Math.hypot(xe, ye)) * R2D;
  const gmst = rev(280.46061837 + 360.98564736629 * (date.getTime() / 86400000 + 2440587.5 - 2451545.0));
  const ha = rev(gmst + lon - ra);
  const alt0 = Math.asin(sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(ha)) * R2D;
  const az = rev(Math.atan2(-sind(ha), Math.tan(dec * D2R) * cosd(lat) - sind(lat) * cosd(ha)) * R2D);
  const alt = alt0 - Math.asin(1 / r) * R2D * cosd(alt0); // 지표면 시차(r: 지구 반지름 단위)
  const elong = Math.acos(Math.max(-1, Math.min(1, cosd(lonE - Ls) * cosd(latE)))) * R2D;
  const lit = (1 - cosd(elong)) / 2, waxing = rev(lonE - Ls) < 180;
  return { alt, az, distKm: r * 6378.14, lit, waxing };
}

export function moonPhaseName(lit, waxing, en) {
  if (lit < 0.03) return en ? 'New moon' : '그믐·삭';
  if (lit > 0.97) return en ? 'Full moon' : '보름달';
  if (lit < 0.4) return waxing ? (en ? 'Waxing crescent' : '초승달') : (en ? 'Waning crescent' : '그믐달');
  if (lit < 0.6) return waxing ? (en ? 'First quarter' : '상현달') : (en ? 'Last quarter' : '하현달');
  return waxing ? (en ? 'Waxing gibbous' : '차오르는 달') : (en ? 'Waning gibbous' : '기우는 달');
}

/** 오늘(자정~자정) 해 경로 / 지금 앞뒤 12시간 달 경로: [{t, az, alt}] 10분 간격. */
export function dayPath(body, now, lat, lon) {
  const pts = [];
  const start = body === 'sun' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : now.getTime() - 12 * 3600000;
  for (let k = 0; k <= 144; k++) {
    const t = new Date(start + k * 600000);
    const p = body === 'sun' ? sunAltAz(t, lat, lon) : moonAltAz(t, lat, lon);
    pts.push({ t, az: p.az, alt: p.alt });
  }
  return pts;
}
