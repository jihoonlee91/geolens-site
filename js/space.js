// 하늘: 행성(Schlyter 궤도요소+섭동, 오차 1~2′), 밝은 별·대표 별자리 선, 인공위성(CelesTrak + SGP4, 앱과 같은 구현).
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrap = d => ((d % 360) + 360) % 360, sind = d => Math.sin(d * D2R), cosd = d => Math.cos(d * D2R);
export const julian = date => date.getTime() / 86400000 + 2440587.5;

/** 그리니치 평균항성시(라디안, Vallado). */
export function gmst(jd) {
  const t = (jd - 2451545.0) / 36525.0;
  const sec = -6.2e-6 * t ** 3 + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  const g = (sec * D2R / 240.0) % (2 * Math.PI);
  return g < 0 ? g + 2 * Math.PI : g;
}
function toHorizontal(ra, dec, lat, lst) {
  const p = lat * D2R, h = lst - ra;
  const alt = Math.asin(Math.max(-1, Math.min(1, Math.sin(p) * Math.sin(dec) + Math.cos(p) * Math.cos(dec) * Math.cos(h)))) * R2D;
  const az = wrap(Math.atan2(-Math.sin(h) * Math.cos(dec), Math.cos(p) * Math.sin(dec) - Math.sin(p) * Math.cos(dec) * Math.cos(h)) * R2D);
  return { az, alt: alt + refraction(alt) };
}
const refraction = alt => (alt < -1 ? 0 : 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * D2R) / 60);
function kepler(mDeg, e) { const m = mDeg * D2R; let E = m + e * Math.sin(m) * (1 + e * Math.cos(m)); for (let i = 0; i < 8; i++) { const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-10) break; } return E; }

const PLANETS = [
  ['mercury', '수성', 'Mercury', d => [48.3313 + 3.24587e-5 * d, 7.0047 + 5.0e-8 * d, 29.1241 + 1.01444e-5 * d, 0.387098, 0.205635 + 5.59e-10 * d, 168.6562 + 4.0923344368 * d], -0.36],
  ['venus', '금성', 'Venus', d => [76.6799 + 2.4659e-5 * d, 3.3946 + 2.75e-8 * d, 54.891 + 1.38374e-5 * d, 0.72333, 0.006773 - 1.302e-9 * d, 48.0052 + 1.6021302244 * d], -4.34],
  ['mars', '화성', 'Mars', d => [49.5574 + 2.11081e-5 * d, 1.8497 - 1.78e-8 * d, 286.5016 + 2.92961e-5 * d, 1.523688, 0.093405 + 2.516e-9 * d, 18.6021 + 0.5240207766 * d], -1.51],
  ['jupiter', '목성', 'Jupiter', d => [100.4542 + 2.76854e-5 * d, 1.303 - 1.557e-7 * d, 273.8777 + 1.64505e-5 * d, 5.20256, 0.048498 + 4.469e-9 * d, 19.895 + 0.0830853001 * d], -9.25],
  ['saturn', '토성', 'Saturn', d => [113.6634 + 2.3898e-5 * d, 2.4886 - 1.081e-7 * d, 339.3939 + 2.97661e-5 * d, 9.55475, 0.055546 - 9.499e-9 * d, 316.967 + 0.0334442282 * d], -9.0],
];

/** 행성(수·금·화·목·토): [{id, ko, en, az, alt, mag, distAu}] */
export function planets(date, lat, lon) {
  const jd = julian(date), d = jd - 2451543.5, ecl = 23.4393 - 3.563e-7 * d, lst = gmst(jd) + lon * D2R;
  // 해(지구중심 황도, AU)
  const ws = 282.9404 + 4.70935e-5 * d, es = 0.016709 - 1.151e-9 * d, Ms = wrap(356.047 + 0.9856002585 * d);
  const Es = kepler(Ms, es), xv = Math.cos(Es) - es, yv = Math.sqrt(1 - es * es) * Math.sin(Es);
  const rs = Math.hypot(xv, yv), ls = wrap(Math.atan2(yv, xv) * R2D + ws), xs = rs * cosd(ls), ys = rs * sind(ls);
  const Mj = wrap(19.895 + 0.0830853001 * d), Msat = wrap(316.967 + 0.0334442282 * d);
  return PLANETS.map(([id, ko, en, el, h], p) => {
    const [N, i, w, a, e, M0] = el(d), M = wrap(M0), E = kepler(M, e);
    const x0 = a * (Math.cos(E) - e), y0 = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(y0, x0) * R2D, r = Math.hypot(x0, y0);
    let xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i)), yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i)), zh = r * sind(v + w) * sind(i);
    if (p === 3 || p === 4) {
      let lo = Math.atan2(yh, xh) * R2D, la = Math.atan2(zh, Math.hypot(xh, yh)) * R2D;
      if (p === 3) lo += -0.332 * sind(2 * Mj - 5 * Msat - 67.6) - 0.056 * sind(2 * Mj - 2 * Msat + 21) + 0.042 * sind(3 * Mj - 5 * Msat + 21) - 0.036 * sind(Mj - 2 * Msat) + 0.022 * cosd(Mj - Msat) + 0.023 * sind(2 * Mj - 3 * Msat + 52) - 0.016 * sind(Mj - 5 * Msat - 69);
      else { lo += 0.812 * sind(2 * Mj - 5 * Msat - 67.6) - 0.229 * cosd(2 * Mj - 4 * Msat - 2) + 0.119 * sind(Mj - 2 * Msat - 3) + 0.046 * sind(2 * Mj - 6 * Msat - 69) + 0.014 * sind(Mj - 3 * Msat + 32); la += -0.02 * cosd(2 * Mj - 4 * Msat - 2) + 0.018 * sind(2 * Mj - 6 * Msat - 49); }
      xh = r * cosd(lo) * cosd(la); yh = r * sind(lo) * cosd(la); zh = r * sind(la);
    }
    const xg = xh + xs, yg = yh + ys, zg = zh, dist = Math.hypot(xg, yg, zg);
    const xe = xg, ye = yg * cosd(ecl) - zg * sind(ecl), ze = yg * sind(ecl) + zg * cosd(ecl);
    const hz = toHorizontal(Math.atan2(ye, xe), Math.atan2(ze, Math.hypot(xe, ye)), lat, lst);
    return { id, ko, en, az: hz.az, alt: hz.alt, mag: h + 5 * Math.log10(r * dist), distAu: dist };
  });
}

// 밝은 별(J2000): [키, 이름, 별자리, 영어 별자리, 적경(시), 적위(도), 등급]
const STARS = [
  ['Sirius', '시리우스', '큰개자리', 'Canis Major', 6.7525, -16.716, -1.46], ['Arcturus', '아르크투루스', '목동자리', 'Bootes', 14.261, 19.182, -0.05],
  ['Vega', '베가(직녀성)', '거문고자리', 'Lyra', 18.6156, 38.784, 0.03], ['Capella', '카펠라', '마차부자리', 'Auriga', 5.2782, 45.998, 0.08],
  ['Rigel', '리겔', '오리온자리', 'Orion', 5.2423, -8.202, 0.13], ['Procyon', '프로키온', '작은개자리', 'Canis Minor', 7.655, 5.225, 0.34],
  ['Betelgeuse', '베텔게우스', '오리온자리', 'Orion', 5.9195, 7.407, 0.5], ['Altair', '알타이르(견우성)', '독수리자리', 'Aquila', 19.8464, 8.868, 0.76],
  ['Aldebaran', '알데바란', '황소자리', 'Taurus', 4.5987, 16.509, 0.86], ['Antares', '안타레스', '전갈자리', 'Scorpius', 16.4901, -26.432, 0.96],
  ['Spica', '스피카', '처녀자리', 'Virgo', 13.4199, -11.161, 0.97], ['Pollux', '폴룩스', '쌍둥이자리', 'Gemini', 7.7553, 28.026, 1.14],
  ['Fomalhaut', '포말하우트', '남쪽물고기자리', 'Piscis Austrinus', 22.9608, -29.622, 1.16], ['Deneb', '데네브', '백조자리', 'Cygnus', 20.6905, 45.28, 1.25],
  ['Regulus', '레굴루스', '사자자리', 'Leo', 10.1395, 11.967, 1.35], ['Castor', '카스토르', '쌍둥이자리', 'Gemini', 7.5767, 31.888, 1.58],
  ['Bellatrix', '벨라트릭스', '오리온자리', 'Orion', 5.4189, 6.35, 1.64], ['Alnilam', '알닐람', '오리온자리', 'Orion', 5.6036, -1.202, 1.69],
  ['Alnitak', '알니탁', '오리온자리', 'Orion', 5.6793, -1.943, 1.77], ['Alioth', '알리오스', '큰곰자리', 'Ursa Major', 12.9005, 55.96, 1.77],
  ['Dubhe', '두베', '큰곰자리', 'Ursa Major', 11.0621, 61.751, 1.79], ['Mirfak', '미르팍', '페르세우스자리', 'Perseus', 3.4054, 49.861, 1.79],
  ['Alkaid', '알카이드', '큰곰자리', 'Ursa Major', 13.7923, 49.313, 1.86], ['Polaris', '북극성', '작은곰자리', 'Ursa Minor', 2.5303, 89.264, 1.98],
  ['Mizar', '미자르', '큰곰자리', 'Ursa Major', 13.3988, 54.925, 2.23], ['Saiph', '사이프', '오리온자리', 'Orion', 5.7959, -9.67, 2.09],
  ['Mintaka', '민타카', '오리온자리', 'Orion', 5.5334, -0.299, 2.23], ['Sadr', '사드르', '백조자리', 'Cygnus', 20.3705, 40.257, 2.23],
  ['Schedar', '셰다르', '카시오페이아자리', 'Cassiopeia', 0.6751, 56.537, 2.24], ['Caph', '카프', '카시오페이아자리', 'Cassiopeia', 0.1529, 59.15, 2.28],
  ['Merak', '메라크', '큰곰자리', 'Ursa Major', 11.0307, 56.382, 2.37], ['Phecda', '페크다', '큰곰자리', 'Ursa Major', 11.8972, 53.695, 2.44],
  ['Navi', '나비', '카시오페이아자리', 'Cassiopeia', 0.9451, 60.717, 2.47], ['Ruchbah', '루크바', '카시오페이아자리', 'Cassiopeia', 1.4302, 60.235, 2.68],
  ['Segin', '세긴', '카시오페이아자리', 'Cassiopeia', 1.9066, 63.67, 3.37], ['Albireo', '알비레오', '백조자리', 'Cygnus', 19.512, 27.96, 3.08],
  ['Megrez', '메그레즈', '큰곰자리', 'Ursa Major', 12.2571, 57.033, 3.31], ['Markab', '마르카브', '페가수스자리', 'Pegasus', 23.0793, 15.205, 2.48],
  ['Scheat', '셰아트', '페가수스자리', 'Pegasus', 23.0629, 28.083, 2.42], ['Alpheratz', '알페라츠', '안드로메다자리', 'Andromeda', 0.1398, 29.091, 2.06],
  ['Algenib', '알게니브', '페가수스자리', 'Pegasus', 0.2206, 15.184, 2.83], ['Alcyone', '플레이아데스(좀생이별)', '황소자리', 'Taurus', 3.7914, 24.105, 2.87],
];
export const FIGURES = [
  ['북두칠성', 'Big Dipper', 'Dubhe-Merak Merak-Phecda Phecda-Megrez Megrez-Dubhe Megrez-Alioth Alioth-Mizar Mizar-Alkaid'],
  ['오리온자리', 'Orion', 'Betelgeuse-Bellatrix Betelgeuse-Alnitak Bellatrix-Mintaka Mintaka-Alnilam Alnilam-Alnitak Alnitak-Saiph Mintaka-Rigel'],
  ['카시오페이아자리', 'Cassiopeia', 'Caph-Schedar Schedar-Navi Navi-Ruchbah Ruchbah-Segin'],
  ['페가수스 대사각형', 'Great Square of Pegasus', 'Markab-Scheat Scheat-Alpheratz Alpheratz-Algenib Algenib-Markab'],
  ['여름의 대삼각형', 'Summer Triangle', 'Vega-Deneb Deneb-Altair Altair-Vega'],
  ['겨울의 대삼각형', 'Winter Triangle', 'Sirius-Procyon Procyon-Betelgeuse Betelgeuse-Sirius'],
  ['백조자리', 'Cygnus', 'Deneb-Sadr Sadr-Albireo'],
];

/** 별 위치(세차 보정): Map 키 → {key, ko, en(=키), con, conEn, mag, az, alt} */
export function stars(date, lat, lon) {
  const jd = julian(date), lst = gmst(jd) + lon * D2R, years = (jd - 2451545.0) / 365.25;
  const m = 3.075 * 15 / 3600 * D2R, n = 20.04 / 3600 * D2R;
  const out = new Map();
  for (const [key, ko, con, conEn, raH, decD, mag] of STARS) {
    const ra0 = raH * 15 * D2R, dec0 = decD * D2R;
    const ra = ra0 + years * (m + n * Math.sin(ra0) * Math.tan(dec0)), dec = dec0 + years * n * Math.cos(ra0);
    const h = toHorizontal(ra, dec, lat, lst);
    out.set(key, { key, ko, en: key, con, conEn, mag, az: h.az, alt: h.alt });
  }
  return out;
}

// ───────── 인공위성: SGP4(근지구, Vallado 2006, WGS72) ─────────
const MU = 398600.8, RE = 6378.135, J2 = 0.001082616, J3 = -0.00000253881, J4 = -0.00000165597;
const XKE = 60.0 / Math.sqrt(RE ** 3 / MU), J3OJ2 = J3 / J2, X2O3 = 2 / 3, TWOPI = 2 * Math.PI;

export class Sgp4 {
  constructor(epochJd, nRevDay, ecc, incDeg, raanDeg, argpDeg, maDeg, bstar) {
    Object.assign(this, { epochJd, ecco: ecc, inclo: incDeg * D2R, nodeo: raanDeg * D2R, argpo: argpDeg * D2R, mo: maDeg * D2R, bstar });
    const noKozai = nRevDay * TWOPI / 1440;
    const eccsq = ecc * ecc, omeosq = 1 - eccsq, rteosq = Math.sqrt(omeosq), cosio = Math.cos(this.inclo), cosio2 = cosio * cosio;
    const ak = Math.pow(XKE / noKozai, X2O3), d1 = 0.75 * J2 * (3 * cosio2 - 1) / (rteosq * omeosq);
    let del = d1 / (ak * ak);
    const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81));
    del = d1 / (adel * adel);
    const no = this.no = noKozai / (1 + del);
    const ao = this.ao = Math.pow(XKE / no, X2O3);
    const sinio = Math.sin(this.inclo), po = ao * omeosq, con42 = 1 - 5 * cosio2;
    this.con41 = -con42 - cosio2 - cosio2;
    const posq = po * po, rp = ao * (1 - ecc);
    this.ok = !(TWOPI / no >= 225 || rp < 1);
    if (!this.ok) return;
    this.isimp = rp < 220 / RE + 1;
    let sfour = 78 / RE + 1, qzms24 = Math.pow((120 - 78) / RE, 4);
    const perige = (rp - 1) * RE;
    if (perige < 156) { sfour = perige - 78; if (perige < 98) sfour = 20; qzms24 = Math.pow((120 - sfour) / RE, 4); sfour = sfour / RE + 1; }
    const pinvsq = 1 / posq, tsi = 1 / (ao - sfour);
    const eta = this.eta = ao * ecc * tsi, etasq = eta * eta, eeta = ecc * eta, psisq = Math.abs(1 - etasq);
    const coef = qzms24 * Math.pow(tsi, 4), coef1 = coef / Math.pow(psisq, 3.5);
    const cc2 = coef1 * no * (ao * (1 + 1.5 * etasq + eeta * (4 + etasq)) + 0.375 * J2 * tsi / psisq * this.con41 * (8 + 3 * etasq * (8 + etasq)));
    const cc1 = this.cc1 = bstar * cc2;
    const cc3 = ecc > 1e-4 ? -2 * coef * tsi * J3OJ2 * no * sinio / ecc : 0;
    this.x1mth2 = 1 - cosio2;
    this.cc4 = 2 * no * coef1 * ao * omeosq * (eta * (2 + 0.5 * etasq) + ecc * (0.5 + 2 * etasq) - J2 * tsi / (ao * psisq) * (-3 * this.con41 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) + 0.75 * this.x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * this.argpo)));
    this.cc5 = 2 * coef1 * ao * omeosq * (1 + 2.75 * (etasq + eeta) + eeta * etasq);
    const cosio4 = cosio2 * cosio2, temp1 = 1.5 * J2 * pinvsq * no, temp2 = 0.5 * temp1 * J2 * pinvsq, temp3 = -0.46875 * J4 * pinvsq * pinvsq * no;
    this.mdot = no + 0.5 * temp1 * rteosq * this.con41 + 0.0625 * temp2 * rteosq * (13 - 78 * cosio2 + 137 * cosio4);
    this.argpdot = -0.5 * temp1 * con42 + 0.0625 * temp2 * (7 - 114 * cosio2 + 395 * cosio4) + temp3 * (3 - 36 * cosio2 + 49 * cosio4);
    const xhdot1 = -temp1 * cosio;
    this.nodedot = xhdot1 + (0.5 * temp2 * (4 - 19 * cosio2) + 2 * temp3 * (3 - 7 * cosio2)) * cosio;
    this.omgcof = bstar * cc3 * Math.cos(this.argpo);
    this.xmcof = ecc > 1e-4 ? -X2O3 * coef * bstar / eeta : 0;
    this.nodecf = 3.5 * omeosq * xhdot1 * cc1;
    this.t2cof = 1.5 * cc1;
    this.xlcof = -0.25 * J3OJ2 * sinio * (3 + 5 * cosio) / (Math.abs(cosio + 1) > 1.5e-12 ? 1 + cosio : 1.5e-12);
    this.aycof = -0.5 * J3OJ2 * sinio;
    this.delmo = Math.pow(1 + eta * Math.cos(this.mo), 3);
    this.sinmao = Math.sin(this.mo);
    this.x7thm1 = 7 * cosio2 - 1;
    if (!this.isimp) {
      const cc1sq = cc1 * cc1;
      this.d2 = 4 * ao * tsi * cc1sq;
      const temp = this.d2 * tsi * cc1 / 3;
      this.d3 = (17 * ao + sfour) * temp;
      this.d4 = 0.5 * temp * ao * tsi * (221 * ao + 31 * sfour) * cc1;
      this.t3cof = this.d2 + 2 * cc1sq;
      this.t4cof = 0.25 * (3 * this.d3 + cc1 * (12 * this.d2 + 10 * cc1sq));
      this.t5cof = 0.2 * (3 * this.d4 + 12 * cc1 * this.d3 + 6 * this.d2 * this.d2 + 15 * cc1sq * (2 * this.d2 + cc1sq));
    }
  }

  /** TEME 위치(km), tsince: 기원 이후 분. 실패하면 null. */
  propagate(t) {
    if (!this.ok) return null;
    const s = this;
    const xmdf = s.mo + s.mdot * t, argpdf = s.argpo + s.argpdot * t, nodedf = s.nodeo + s.nodedot * t, t2 = t * t;
    let argpm = argpdf, mm = xmdf, nodem = nodedf + s.nodecf * t2;
    let tempa = 1 - s.cc1 * t, tempe = s.bstar * s.cc4 * t, templ = s.t2cof * t2;
    if (!s.isimp) {
      const delomg = s.omgcof * t, delm = s.xmcof * (Math.pow(1 + s.eta * Math.cos(xmdf), 3) - s.delmo), temp = delomg + delm;
      mm = xmdf + temp; argpm = argpdf - temp;
      const t3 = t2 * t, t4 = t3 * t;
      tempa = tempa - s.d2 * t2 - s.d3 * t3 - s.d4 * t4;
      tempe += s.bstar * s.cc5 * (Math.sin(mm) - s.sinmao);
      templ += s.t3cof * t3 + t4 * (s.t4cof + t * s.t5cof);
    }
    const am = Math.pow(XKE / s.no, X2O3) * tempa * tempa;
    let em = s.ecco - tempe;
    if (em >= 1 || em < -0.001) return null;
    if (em < 1e-6) em = 1e-6;
    mm += s.no * templ;
    let xlm = mm + argpm + nodem;
    nodem %= TWOPI; argpm %= TWOPI; xlm %= TWOPI; mm = (xlm - argpm - nodem) % TWOPI;
    const sinip = Math.sin(s.inclo), cosip = Math.cos(s.inclo);
    const axnl = em * Math.cos(argpm), tmp = 1 / (am * (1 - em * em)), aynl = em * Math.sin(argpm) + tmp * s.aycof;
    const xl = mm + argpm + nodem + tmp * s.xlcof * axnl, u = (xl - nodem) % TWOPI;
    let eo1 = u, tem5 = 9999.9, sineo1 = 0, coseo1 = 0;
    for (let k = 1; Math.abs(tem5) >= 1e-12 && k <= 10; k++) {
      sineo1 = Math.sin(eo1); coseo1 = Math.cos(eo1);
      tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / (1 - coseo1 * axnl - sineo1 * aynl);
      if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0 ? 0.95 : -0.95;
      eo1 += tem5;
    }
    const ecose = axnl * coseo1 + aynl * sineo1, esine = axnl * sineo1 - aynl * coseo1, el2 = axnl * axnl + aynl * aynl, pl = am * (1 - el2);
    if (pl < 0) return null;
    const rl = am * (1 - ecose), betal = Math.sqrt(1 - el2), temp0 = esine / (1 + betal);
    const sinu = am / rl * (sineo1 - aynl - axnl * temp0), cosu = am / rl * (coseo1 - axnl + aynl * temp0);
    let su = Math.atan2(sinu, cosu);
    const sin2u = (cosu + cosu) * sinu, cos2u = 1 - 2 * sinu * sinu, tp = 1 / pl, tp1 = 0.5 * J2 * tp, tp2 = tp1 * tp;
    const mrt = rl * (1 - 1.5 * tp2 * betal * s.con41) + 0.5 * tp1 * s.x1mth2 * cos2u;
    su -= 0.25 * tp2 * s.x7thm1 * sin2u;
    const xnode = nodem + 1.5 * tp2 * cosip * sin2u, xinc = s.inclo + 1.5 * tp2 * cosip * sinip * cos2u;
    if (mrt < 1) return null;
    const sinsu = Math.sin(su), cossu = Math.cos(su), snod = Math.sin(xnode), cnod = Math.cos(xnode), sini = Math.sin(xinc), cosi = Math.cos(xinc);
    const xmx = -snod * cosi, xmy = cnod * cosi;
    return [mrt * (xmx * sinsu + cnod * cossu) * RE, mrt * (xmy * sinsu + snod * cossu) * RE, mrt * sini * sinsu * RE];
  }
}

/** 관측자(위경도·해발 m) → 위성 방위·고도·거리(km), 햇빛 받는지. */
export function satLook(model, date, lat, lon, alt) {
  const jd = julian(date), r = model.propagate((jd - model.epochJd) * 1440);
  if (!r) return null;
  const g = gmst(jd), c = Math.cos(g), s = Math.sin(g);
  const x = c * r[0] + s * r[1], y = -s * r[0] + c * r[1], z = r[2]; // ECEF km
  // 관측자 ECEF(WGS84)
  const a = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f), p = lat * D2R, l = lon * D2R, h = alt / 1000;
  const N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const ox = (N + h) * Math.cos(p) * Math.cos(l), oy = (N + h) * Math.cos(p) * Math.sin(l), oz = (N * (1 - e2) + h) * Math.sin(p);
  const dx = x - ox, dy = y - oy, dz = z - oz;
  const east = -Math.sin(l) * dx + Math.cos(l) * dy;
  const north = -Math.sin(p) * Math.cos(l) * dx - Math.sin(p) * Math.sin(l) * dy + Math.cos(p) * dz;
  const up = Math.cos(p) * Math.cos(l) * dx + Math.cos(p) * Math.sin(l) * dy + Math.sin(p) * dz;
  const range = Math.hypot(east, north, up);
  // 햇빛(원통형 그림자 근사)
  const n = jd - 2451545.0, L = (280.46 + 0.9856474 * n) % 360, gg = (357.528 + 0.9856003 * n) % 360;
  const lam = (L + 1.915 * sind(gg) + 0.02 * sind(2 * gg)) * D2R, eps = (23.439 - 4e-7 * n) * D2R;
  const sx0 = Math.cos(lam), sy0 = Math.cos(eps) * Math.sin(lam), sz = Math.sin(eps) * Math.sin(lam);
  const sx = c * sx0 + s * sy0, sy = -s * sx0 + c * sy0;
  const proj = x * sx + y * sy + z * sz;
  const sunlit = proj > 0 || Math.hypot(x - sx * proj, y - sy * proj, z - sz * proj) > 6371;
  return { az: wrap(Math.atan2(east, north) * R2D), alt: Math.asin(up / range) * R2D, rangeKm: range, heightKm: Math.hypot(x, y, z) - 6371, sunlit };
}

const KO_SAT = { 25544: ['국제우주정거장(ISS)', 'International Space Station (ISS)'], 48274: ['톈궁 우주정거장(CSS)', 'Tiangong Space Station (CSS)'], 20580: ['허블 우주망원경', 'Hubble Space Telescope'] };

/** CelesTrak(무료, CORS 허용) 궤도요소 → [{id, norad, ko, en, model}]. 기기에 12시간 저장. */
export async function loadSatellites() {
  const key = 'geolens.cache.sats';
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.t < 12 * 3600000) return build(c.v); } catch { }
  const rows = [];
  for (const grp of ['stations', 'visual']) {
    try {
      const j = await (await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${grp}&FORMAT=json`)).json();
      for (const o of j) rows.push([o.NORAD_CAT_ID, o.OBJECT_NAME, o.EPOCH, o.MEAN_MOTION, o.ECCENTRICITY, o.INCLINATION, o.RA_OF_ASC_NODE, o.ARG_OF_PERICENTER, o.MEAN_ANOMALY, o.BSTAR]);
    } catch { }
  }
  if (rows.length) try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: rows })); } catch { }
  return build(rows);
}
function build(rows) {
  const seen = new Set(), out = [];
  for (const [id, name, epoch, nn, e, i, raan, w, ma, b] of rows) {
    if (seen.has(id)) continue; seen.add(id);
    const ep = Date.parse(epoch.endsWith('Z') ? epoch : epoch + 'Z');
    const model = new Sgp4(ep / 86400000 + 2440587.5, nn, e, i, raan, w, ma, b || 0);
    if (!model.ok) continue;
    const pretty = n => (n.startsWith('CSS') ? KO_SAT[48274] : n.includes(' R/B') ? [n.replace(' R/B', ' 로켓 잔해'), n.replace(' R/B', ' rocket body')] : [n, n]);
    const [ko, en] = KO_SAT[id] || pretty(name || 'SAT');
    out.push({ id: 'sat:' + id, norad: id, ko, en, model, debris: / DEB|R\/B/.test(name || '') });
  }
  return out;
}
