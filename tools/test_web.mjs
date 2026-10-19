// 웹 앱 계산 시험: node tools/test_web.mjs
// 자세 필터(자이로+가속도+나침반)를 가짜 센서(영점 오차·잡음·늦은 나침반·자기 간섭)로 돌려 오차를 재고,
// GPS 칼만 필터·태양 계산을 기준값과 비교한다.
import { OrientationFilter, qaxis, qmul, qrot, qrotInv, qnorm, qFromEuler, cameraAzEl } from '../js/fusion.js';
import { GpsFilter } from '../js/gps.js';
import { romanize } from '../js/hangul.js';
import { haversine, bearing, elevationAngle, sunAltAz, nextSunEvent, wrap180, fromEnu } from '../js/geo.js';

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
const D2R = Math.PI / 180;
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// 진짜 자세: 카메라가 방위 az, 고도 el을 보는 세로 들기(화면 위가 하늘 쪽)
function trueQ(az, el, roll = 0) {
  // 기기 −z가 (az, el)을 보게: 먼저 세로로 세움(x축 +90°) → 고도 → 방위(세계 z, 시계 방향이 −)
  const upright = qaxis(1, 0, 0, Math.PI / 2);
  return qnorm(qmul(qaxis(0, 0, 1, -az * D2R), qmul(upright, qmul(qaxis(1, 0, 0, el * D2R), qaxis(0, 0, 1, roll * D2R)))));
}
// 두 자세 차이로 기기 각속도(rad/s): ω = 2·log(q1⁻¹q2)/dt
function bodyRate(q1, q2, dt) {
  const d = qmul([q1[0], -q1[1], -q1[2], -q1[3]], q2);
  const s = Math.hypot(d[1], d[2], d[3]); if (s < 1e-12) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, d[0]); return [d[1] / s * ang / dt, d[2] / s * ang / dt, d[3] / s * ang / dt];
}

function run({ motion, seconds = 20, bias = [0.01, -0.008, 0.012], gyroNoise = 0.004, refNoiseDeg = 1.0, refLagMs = 60, disturb = null, refEvery = 1 }) {
  const f = new OrientationFilter();
  let t = 0; f.now = () => t * 1000;
  const dt = 1 / 60, hist = [];
  let maxErr = 0, sumErr = 0, n = 0, maxElErr = 0, lastQ = null;
  for (let i = 0; i < seconds / dt; i++) {
    t = i * dt;
    const { az, el } = motion(t), q = trueQ(az, el);
    hist.push(q);
    if (lastQ) {
      const w = bodyRate(lastQ, q, dt).map((x, k) => x + bias[k] + gyroNoise * gauss());
      const up = qrotInv(q, [0, 0, 1]); // 가속도계: 중력 반작용(위) + 잡음
      const acc = up.map(x => x * 9.81 + 0.08 * gauss());
      f.update(w, acc, dt);
    }
    // 나침반: 늦게(lag) 도착, 잡음, 간섭(방위 오프셋)
    if (i % refEvery === 0) {
      const lagged = hist[Math.max(0, hist.length - 1 - Math.round(refLagMs / 1000 / dt))];
      const off = (disturb ? disturb(t) : 0) + refNoiseDeg * gauss();
      f.setReference(qmul(qaxis(0, 0, 1, -off * D2R), lagged));
    }
    lastQ = q;
    if (t > 4) { // 수렴 후 오차
      const a = cameraAzEl(f.q), b = cameraAzEl(q);
      const e = Math.abs(wrap180(a.az - b.az)), ee = Math.abs(a.el - b.el);
      maxErr = Math.max(maxErr, e); maxElErr = Math.max(maxElErr, ee); sumErr += e; n++;
    }
  }
  return { maxErr, meanErr: sumErr / n, maxElErr, bias: f.bias, trust: f.trust, lag: f.compassLagMs };
}

// 1) 가만히 들고 있기: 영점 오차·잡음이 있어도 방위 1° 안
let r = run({ motion: () => ({ az: 30, el: 3 }) });
check('정지: 방위 오차', r.meanErr < 1 && r.maxErr < 2.5, `평균 ${r.meanErr.toFixed(2)}° 최대 ${r.maxErr.toFixed(2)}°, 고도 최대 ${r.maxElErr.toFixed(2)}°`);
check('정지: 기울기(고도각) 오차', r.maxElErr < 1, `${r.maxElErr.toFixed(2)}°`);

// 2) 좌우로 둘러보기(±60°, 초당 최대 60°) + 위아래: 나침반이 60 ms 늦어도 자이로로 따라감
r = run({ motion: t => ({ az: 100 + 60 * Math.sin(t * 0.9), el: 5 + 10 * Math.sin(t * 0.5) }) });
check('둘러보기: 방위 오차', r.meanErr < 1 && r.maxErr < 3, `평균 ${r.meanErr.toFixed(2)}° 최대 ${r.maxErr.toFixed(2)}°, 추정 지연 ${r.lag} ms(실제 60)`);
r = run({ motion: t => ({ az: 100 + 60 * Math.sin(t * 0.9), el: 5 }), refLagMs: 130, seconds: 30 });
check('둘러보기(나침반 130 ms 지연): 지연 추정', r.meanErr < 1.2 && Math.abs(r.lag - 133) <= 34, `평균 ${r.meanErr.toFixed(2)}° 최대 ${r.maxErr.toFixed(2)}°, 추정 지연 ${r.lag} ms`);

// 3) 자기 간섭: 4~12초 동안 나침반이 ±35° 출렁(차·철근 옆) → 필터는 크게 안 흔들려야
r = run({ motion: t => ({ az: 200 + 20 * Math.sin(t * 0.3), el: 2 }), disturb: t => (t > 6 && t < 12 ? 35 * Math.sin(t * 2.5) : 0) });
check('자기 간섭: 방위 오차(나침반 원값 ±35°)', r.maxErr < 10, `최대 ${r.maxErr.toFixed(2)}° 평균 ${r.meanErr.toFixed(2)}°`);

// 4) 큰 자이로 영점 오차(위축 0.03 rad/s ≈ 1.7°/s): 적분항이 잡아 방위가 남지 않음
r = run({ motion: () => ({ az: 300, el: 0 }), bias: [0.0, 0.03, 0.0], seconds: 40 });
check('영점 오차 1.7°/s: 방위 오차', r.meanErr < 1.2, `평균 ${r.meanErr.toFixed(2)}° 최대 ${r.maxErr.toFixed(2)}°`);

// 5) W3C 오일러 → 쿼터니언: alpha=0, 세로로 세움(beta=90) → 카메라는 북쪽 수평
{ const a = cameraAzEl(qFromEuler(0, 90, 0)), b = cameraAzEl(qFromEuler(90, 90, 0));
  check('deviceorientation 변환', Math.abs(wrap180(a.az - 0)) < 0.01 && Math.abs(a.el) < 0.01 && Math.abs(wrap180(b.az - 270)) < 0.01, `α0→${a.az.toFixed(1)}°, α90→${b.az.toFixed(1)}°(서쪽이어야)`); }

// 6) GPS 칼만: 서 있을 때 ±15 m 잡음 → 필터 위치 오차가 원값보다 훨씬 작고, 튀는 값(300 m)은 버림
{
  const g = new GpsFilter(), lat0 = 37.6586, lon0 = 126.9776;
  let raw = 0, filt = 0, n = 0;
  for (let i = 0; i < 120; i++) {
    const [la, lo] = fromEnu(lat0, lon0, 15 * gauss(), 15 * gauss());
    g.update(i === 60 ? la + 0.003 : la, lo, 15, i * 1000, 0);
    if (i > 20) { const p = g.position(); raw += haversine(la, lo, lat0, lon0); filt += haversine(p.lat, p.lon, lat0, lon0); n++; }
  }
  check('GPS 정지: 잡음 감소', filt / n < raw / n * 0.4, `원값 평균 ${(raw / n).toFixed(1)} m → 필터 ${(filt / n).toFixed(1)} m`);
  // 걷기(1.4 m/s 북쪽): 늦게 따라오지 않음
  const w = new GpsFilter(); let lag = 0;
  for (let i = 0; i < 90; i++) {
    const [la, lo] = fromEnu(lat0, lon0, 5 * gauss(), 1.4 * i + 5 * gauss());
    w.update(la, lo, 5, i * 1000, 1);
    if (i > 30) { const p = w.position(); const [tla, tlo] = fromEnu(lat0, lon0, 0, 1.4 * i); lag = Math.max(lag, haversine(p.lat, p.lon, tla, tlo)); }
  }
  check('GPS 걷기: 따라감', lag < 11, `최대 오차 ${lag.toFixed(1)} m (측정 잡음 5 m)`);
}

// 7) 거리·방위·올려볼 각: 남산(37.5512,126.9882) → 북한산 백운대(37.6586,126.9776)
{ const d = haversine(37.5512, 126.9882, 37.6586, 126.9776), b = bearing(37.5512, 126.9882, 37.6586, 126.9776);
  check('거리·방위', Math.abs(d - 11990) < 60 && Math.abs(b - 355.3) < 0.5, `${(d / 1000).toFixed(2)} km, ${b.toFixed(1)}°`);
  const e = elevationAngle(100000, 0); check('곡률·굴절(100 km)', Math.abs(e - (-0.391)) < 0.01, `${e.toFixed(3)}°`); }

// 8) 태양: 2026-10-11 서울 해돋이 — 손 계산(적위 −7.02°, 균시차 +13.1분, 굴절 포함 −0.833°) 06:36.5 KST, 방위 98.2°
{ const ev = nextSunEvent(new Date('2026-10-10T18:00:00Z'), 37.5665, 126.978);
  const kst = new Date(ev.time.getTime() + 9 * 3600000);
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  check('해돋이 시각·방위', ev.rise && Math.abs(mins - (6 * 60 + 36)) <= 2 && Math.abs(ev.az - 98.2) < 1, `${kst.toISOString().slice(11, 16)} KST, ${ev.az.toFixed(1)}°`);
  const s = sunAltAz(new Date('2026-06-21T03:30:00Z'), 37.5665, 126.978); // 하지 정오 무렵: 고도 ≈ 75.9°
  check('태양 남중 고도(하지)', Math.abs(s.alt - 75.9) < 0.6, `${s.alt.toFixed(2)}°, 방위 ${s.az.toFixed(1)}°`); }

// 9) 로마자(앱과 같은 사례)
for (const [ko, en] of [['율리봉', 'Yullibong'], ['독립문', 'Dongnimmun'], ['종로', 'Jongno'], ['명동9길', 'Myeongdong 9-gil'], ['북한산 백운대', 'Bukhansan Baegundae'], ['신라', 'Silla']])
  check(`로마자 ${ko}`, romanize(ko) === en, romanize(ko));

console.log(fails ? `\n${fails}개 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);
