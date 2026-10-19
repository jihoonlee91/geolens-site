// GPS 위치 필터: 지역 평면(동·북, m)에서 축마다 [위치, 속도] 등속 모델 칼만 필터.
//  · 측정 잡음 = 휴대폰이 알려 주는 정확도(1σ, m)²
//  · 과정 잡음(가속) = 가속도계로 판단한 움직임 상태에 맞춤: 서 있으면 아주 작게(정상에서 위치가 꿈틀대지 않게),
//    걷거나 차로 움직이면 크게(늦게 따라오지 않게)
//  · 튀는 값 거르기: 예측과의 마할라노비스 거리가 크면 버림(연속 3번이면 새 위치로 다시 시작 — 차에서 내린 경우 등)
import { toEnu, fromEnu } from './geo.js';

export class GpsFilter {
  constructor() { this.reset(); }
  reset() { this.origin = null; this.x = null; this.rejects = 0; this.t = 0; this.acc = Infinity; }

  /** 측정 1회. moving: 0(정지)~1(이동) 가속도계 판단. 반환: 받아들였으면 true. */
  update(lat, lon, accuracy, tMs, moving = 0.5) {
    const r = Math.max(3, accuracy || 30);
    if (!this.origin) { this.start(lat, lon, r, tMs); return true; }
    const dt = Math.min(30, Math.max(0, (tMs - this.t) / 1000));
    const [e, n] = toEnu(this.origin[0], this.origin[1], lat, lon);
    // 원점에서 2 km 넘으면 평면 근사 오차가 커지므로 새 원점
    if (Math.hypot(e, n) > 2000) { const p = this.position(); this.origin = [p.lat, p.lon]; return this.update(lat, lon, accuracy, tMs, moving); }
    const qa = 0.02 + moving * 1.5; // 가속 잡음 밀도((m/s²)²·s): 정지 0.02, 걷기~차 1.5
    const ax = this.predict(this.x[0], dt, qa), ay = this.predict(this.x[1], dt, qa);
    // 게이트: 두 축 합친 마할라노비스 거리²(자유도 2, 99.9% ≈ 13.8)
    const R = r * r;
    const d2 = (e - ax.p) ** 2 / (ax.P[0] + R) + (n - ay.p) ** 2 / (ay.P[0] + R);
    if (d2 > 13.8 && r < 200) {
      if (++this.rejects >= 3) { this.start(lat, lon, r, tMs); return true; }
      return false;
    }
    this.rejects = 0;
    this.x = [this.correct(ax, e, R), this.correct(ay, n, R)];
    this.t = tMs;
    this.acc = Math.sqrt(this.x[0].P[0] + this.x[1].P[0]) / Math.SQRT2;
    return true;
  }

  start(lat, lon, r, tMs) {
    this.origin = [lat, lon]; this.t = tMs; this.rejects = 0; this.acc = r;
    const s = { p: 0, v: 0, P: [r * r, 0, 0, 4] }; // 속도 초기 불확실 2 m/s
    this.x = [s, { ...s, P: s.P.slice() }];
  }

  // 1축 예측: [p, v], P = [Ppp, Ppv, Pvp, Pvv]
  predict(s, dt, qa) {
    const [a, b, , d] = s.P;
    const p = s.p + s.v * dt, v = s.v;
    const q11 = qa * dt ** 3 / 3, q12 = qa * dt ** 2 / 2, q22 = qa * dt;
    const P00 = a + 2 * dt * b + dt * dt * d + q11, P01 = b + dt * d + q12, P11 = d + q22;
    return { p, v, P: [P00, P01, P01, P11] };
  }

  correct(s, z, R) {
    const [a, b, , d] = s.P, S = a + R, k0 = a / S, k1 = b / S, y = z - s.p;
    return { p: s.p + k0 * y, v: s.v + k1 * y, P: [(1 - k0) * a, (1 - k0) * b, (1 - k0) * b, d - k1 * b] };
  }

  /** 필터 위치(위경도)·추정 정확도(m)·속력(m/s). */
  position() {
    if (!this.x) return null;
    const [lat, lon] = fromEnu(this.origin[0], this.origin[1], this.x[0].p, this.x[1].p);
    return { lat, lon, accuracy: this.acc, speed: Math.hypot(this.x[0].v, this.x[1].v) };
  }
}

/** 가속도계로 움직임 판단: 중력 뺀 가속도 크기의 1초 평균 → 0(정지)~1(걷기 이상). */
export class MotionDetector {
  constructor() { this.level = 0; }
  push(lin, dt) {
    const m = Math.hypot(lin[0], lin[1], lin[2]);
    const k = Math.min(1, dt / 1.0);
    this.level = this.level * (1 - k) + Math.min(1, Math.max(0, (m - 0.15) / 1.2)) * k;
    return this.level;
  }
}
