// 자세 추정: 자이로(빠르고 매끄러움) + 가속도계(기울기 기준) + 나침반(방위 기준)을 합치는 상보 필터(Mahony 방식, 쿼터니언).
//
//  · 자이로 각속도를 적분해 매 순간의 자세를 만든다 → 지연·떨림이 거의 없음.
//  · 기울기(롤·피치): 가속도계가 재는 중력 방향과 비교해 오차를 조금씩 되먹임. 걷거나 흔들 때(|a|≠g)는 믿음을 낮춘다.
//  · 방위(요): 나침반 기반 절대 방향(deviceorientationabsolute / iOS webkitCompassHeading)을 느리게 따라간다.
//    자이로가 "안 돌았다"는데 나침반만 출렁이면 자기장 간섭(철근·차·전선)으로 보고 그동안은 거의 무시한다.
//  · 자이로 영점(바이어스): 오차의 적분항으로 천천히 추정해 시간이 지나도 표류하지 않게.
//  · 사용자 [방향 맞춤]: 해·산을 기준으로 맞춘 보정값을 나침반 기준에 더해 계속 유지.
//
// 좌표계: 세계 = ENU(x 동, y 북, z 위), 기기 = W3C(x 화면 오른쪽, y 화면 위, z 화면 밖). 쿼터니언 q = 기기→세계.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export const qconj = q => [q[0], -q[1], -q[2], -q[3]];
export function qnorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; }
export function qaxis(ax, ay, az, ang) { const s = Math.sin(ang / 2); return [Math.cos(ang / 2), ax * s, ay * s, az * s]; }
/** 벡터 v를 q로 회전(기기 → 세계). */
export function qrot(q, v) {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}
/** 세계 → 기기. */
export const qrotInv = (q, v) => qrot(qconj(q), v);

/** W3C deviceorientation(alpha, beta, gamma; Z-X'-Y'' 내재 회전, 도) → 쿼터니언(기기→세계). */
export function qFromEuler(alpha, beta, gamma) {
  const x = beta * D2R / 2, y = gamma * D2R / 2, z = alpha * D2R / 2;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  return [
    cX * cY * cZ - sX * sY * sZ,
    sX * cY * cZ - cX * sY * sZ,
    cX * sY * cZ + sX * cY * sZ,
    cX * cY * sZ + sX * sY * cZ,
  ];
}

/** q가 세계 z축(위)으로 돈 각(라디안) — 스윙-트위스트 분해의 트위스트. */
export const yawOf = q => 2 * Math.atan2(q[3], q[0]);
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

/** 카메라(기기 −z)가 보는 방위·고도각(도). */
export function cameraAzEl(q) {
  const f = qrot(q, [0, 0, -1]);
  return { az: ((Math.atan2(f[0], f[1]) * R2D) + 360) % 360, el: Math.asin(Math.max(-1, Math.min(1, f[2]))) * R2D };
}

export class OrientationFilter {
  constructor() {
    this.q = [1, 0, 0, 0];
    this.bias = [0, 0, 0];      // 자이로 영점(rad/s, 기기 좌표)
    this.ready = false;         // 첫 기준(기울기·방위)을 잡았는지
    this.headingLocked = false; // 나침반 기준을 한 번이라도 받았는지
    this.userYaw = 0;           // [방향 맞춤] 보정(라디안, 세계 z축 회전)
    this.kp = 1.0;              // 기울기 되먹임 이득(1/s)
    this.ki = 0.3;              // 영점 적분 이득(기울기 축) — 감쇠비 약 0.9
    this.kYaw = 0.6;            // 방위 되먹임 이득(1/s, 간섭 없을 때) → 시상수 약 1.7초
    this.kiYaw = 0.12;          // 위축 자이로 영점 적분 이득
    this.jitter = 0;            // 나침반 혁신값 변화율(도/s, 지수평균) — 간섭 감지
    this.lastInnov = null;
    this.trust = 1;             // 0~1 나침반 신뢰도(화면 표시용)
    this.gyroHz = 0;
    this.refAccuracy = null;    // iOS webkitCompassAccuracy(도)
    this.ref = null; this.refT = 0;
    this.lastGyroT = 0;
    this.now = () => performance.now(); // 시험에서 가짜 시계로 바꿀 수 있게
    this.hist = [];                     // 최근 350 ms 자세 [시각, q]
    this.lagCost = LAGS.map(() => 1e-4); this.lagMean = LAGS.map(() => 0); this.lagIdx = 2;
  }

  /** 나침반 기반 절대 방향(기기→세계). 기울기도 들어 있지만 여기선 방위만 쓴다. */
  setReference(qRef, accuracyDeg = null) {
    this.ref = qRef; this.refT = this.now(); this.refAccuracy = accuracyDeg; this.refFresh = true;
    if (!this.ready) { // 첫 값: 바로 그 자세로 시작
      this.q = qRef.slice(); this.ready = true; this.headingLocked = true; this.startT = this.refT; this.hist.length = 0;
    } else if (!this.headingLocked) {
      // 자이로·가속도로 먼저 시작했으면 방위만 맞춘다
      const d = wrapPi(yawOf(qmul(qmul(qaxis(0, 0, 1, this.userYaw), qRef), qconj(this.q))));
      this.q = this.rotateYaw(this.q, d); this.headingLocked = true; this.startT = this.refT;
    }
    if (!this.gyroHz) this.q = qnorm(this.slerpYawTo(qRef, 0.25)); // 자이로가 없는 기기: 나침반을 부드럽게 따라감
  }

  slerpYawTo(qRef, k) {
    const target = qmul(qaxis(0, 0, 1, this.userYaw), qRef);
    // 자이로 없음: 기울기·방위 모두 기준을 따라가되 덜컹임은 줄인다
    const d = qmul(target, qconj(this.q));
    const ang = 2 * Math.acos(Math.max(-1, Math.min(1, Math.abs(d[0])))), s = Math.sqrt(Math.max(1e-12, 1 - d[0] * d[0]));
    if (ang < 1e-4) return target;
    const sign = d[0] < 0 ? -1 : 1;
    return qmul(qaxis(sign * d[1] / s, sign * d[2] / s, sign * d[3] / s, ang * k), this.q);
  }

  /**
   * 자이로·가속도 한 번(devicemotion). gyro: rad/s(기기 x,y,z), acc: 중력 포함 가속도(m/s², 위쪽 +), dt: 초.
   */
  update(gyro, acc, dt) {
    if (!(dt > 0) || dt > 0.2) dt = Math.min(0.2, Math.max(0.001, dt || 0.016));
    this.gyroHz = this.gyroHz ? this.gyroHz * 0.98 + (1 / dt) * 0.02 : 1 / dt;
    let q = this.q;
    const e = [0, 0, 0];
    let accW = 0;
    const gmag = Math.hypot(gyro[0] - this.bias[0], gyro[1] - this.bias[1], gyro[2] - this.bias[2]);

    // 1) 기울기: 측정 중력(위) a × 추정 위 방향 v  → 오차. 가속도는 이번 회전이 끝난 시점 값이므로 자이로로 먼저 예측한 자세와 비교
    if (acc) {
      const n = Math.hypot(acc[0], acc[1], acc[2]);
      if (n > 1) {
        const a = [acc[0] / n, acc[1] / n, acc[2] / n];
        if (!this.ready) { this.q = tiltOnly(a); this.ready = true; return; }
        const v = qrotInv(integrate(q, [gyro[0] - this.bias[0], gyro[1] - this.bias[1], gyro[2] - this.bias[2]], dt), [0, 0, 1]);
        // 흔들림·빠른 회전 중엔 가속도에 중력 외 성분이 섞임 → 가중치↓
        accW = Math.exp(-(((n - 9.81) / 1.2) ** 2)) * (gmag < 1.5 ? 1 : 0.3);
        e[0] = (a[1] * v[2] - a[2] * v[1]) * accW;
        e[1] = (a[2] * v[0] - a[0] * v[2]) * accW;
        e[2] = (a[0] * v[1] - a[1] * v[0]) * accW;
      }
    }
    if (!this.ready) return;

    // 2) 영점 추정(움직임이 적을 때만): b ← b − ki·e·dt
    if (accW > 0.5 && gmag < 0.5) for (let i = 0; i < 3; i++) this.bias[i] -= this.ki * e[i] * dt;

    // 3) 자이로 적분(보정 포함): q ← q ⊗ exp(½ω'dt)
    q = integrate(q, [gyro[0] - this.bias[0] + this.kp * e[0], gyro[1] - this.bias[1] + this.kp * e[1], gyro[2] - this.bias[2] + this.kp * e[2]], dt);
    const tNow = this.now();
    this.hist.push([tNow, q]);
    while (this.hist.length > 2 && tNow - this.hist[0][0] > 350) this.hist.shift();

    // 4) 방위: 새 나침반 값이 왔을 때만, 기준(+사용자 보정)과의 요 차이를 간섭 정도에 따라 천천히 되먹임.
    //    나침반은 수십 ms 늦게 도착 → 그 늦음(지연)을 스스로 추정해 "그때의 자세"와 비교한다.
    if (this.refFresh && this.ref && gmag < 2) {
      this.refFresh = false;
      const now = this.refT, rdt = Math.min(0.5, Math.max(0.005, (now - (this.lastRefUse || now - 16)) / 1000));
      this.lastRefUse = now;
      const target = qmul(qaxis(0, 0, 1, this.userYaw), this.ref);
      // 지연 후보마다 차이를 구해, 돌리는 동안 차이가 가장 덜 출렁이는 지연을 고른다
      let innov = null;
      for (let i = 0; i < LAGS.length; i++) {
        const qa = this.atTime(now - LAGS[i]);
        const d = wrapPi(yawOf(qmul(target, qconj(qa))));
        if (gmag > 0.2) { // 회전 중일 때만 지연 학습
          const m = this.lagMean[i] + wrapPi(d - this.lagMean[i]) * 0.05;
          this.lagCost[i] = this.lagCost[i] * 0.98 + wrapPi(d - m) ** 2 * 0.02;
          this.lagMean[i] = m;
        }
        if (i === this.lagIdx) innov = d;
      }
      let best = this.lagIdx;
      for (let i = 0; i < LAGS.length; i++) if (this.lagCost[i] < this.lagCost[best] * 0.9) best = i;
      this.lagIdx = best;
      // 간섭 감지: 차이를 0.4초 저역 통과한 값이 얼마나 빨리 움직이나(도/s). 나침반의 흰 잡음은 걸러지고,
      // 자기장 왜곡처럼 수 초에 걸쳐 방향이 끌려가는 변화만 커진다. 우리 되먹임만큼은 빼고 비교.
      const still = 1 / (1 + (gmag / 1.0) ** 2); // 아주 빠른 회전 중엔 조금 덜
      if (this.lastInnov != null) {
        const a = Math.min(1, rdt / 0.4);
        const prev = this.innovLP;
        this.innovLP = prev + wrapPi(innov - prev) * a;
        const rate = Math.abs(wrapPi(this.innovLP - prev)) * R2D / rdt;
        this.jitter = this.jitter * (1 - a) + Math.min(rate, 200) * a;
      } else if (this.lastInnov == null) this.innovLP = innov;
      let trust = Math.max(0.03, 1 - this.jitter / 20);
      if (this.refAccuracy != null && this.refAccuracy > 0) trust *= Math.max(0.1, Math.min(1, 15 / this.refAccuracy));
      this.trust = this.trust * 0.9 + trust * 0.1;
      // 시작 직후 3초와 큰 차이(간섭이 끝나고 돌아온 경우 등)는 빠르게, 평소엔 시상수 약 1.7초
      const boost = now - (this.startT || 0) < 3000 ? 5 : 1;
      const k = Math.min(1, this.kYaw * this.trust * boost * (boost > 1 ? 1 : still) * rdt);
      q = this.rotateYaw(q, innov * k);
      this.lastInnov = innov * (1 - k);
      this.innovLP -= innov * k;
      // 위(세계 z)축 자이로 영점은 중력으로는 안 보임 → 나침반 차이의 적분으로 추정(믿을 만할 때만)
      if (this.trust > 0.6 && boost === 1) {
        const up = qrotInv(q, [0, 0, 1]), g = this.kiYaw * innov * rdt;
        for (let i = 0; i < 3; i++) this.bias[i] -= g * up[i];
      }
    }
    this.q = q;
  }

  /** 세계 위축으로 d(라디안) 돌림 — 지연 비교용 과거 자세도 같이(되먹임이 두 번 세어지지 않게). */
  rotateYaw(q, d) {
    const r = qaxis(0, 0, 1, d);
    for (const h of this.hist) h[1] = qmul(r, h[1]);
    return qnorm(qmul(r, q));
  }

  /** 시각 t(ms)에 가장 가까운 과거 자세. */
  atTime(t) {
    const h = this.hist;
    if (!h.length) return this.q;
    let best = h[h.length - 1];
    for (let i = h.length - 1; i >= 0; i--) { if (Math.abs(h[i][0] - t) < Math.abs(best[0] - t)) best = h[i]; if (h[i][0] < t) break; }
    return best[1];
  }

  /** 추정한 나침반 지연(ms) — 화면 표시용. */
  get compassLagMs() { return LAGS[this.lagIdx]; }

  /** [방향 맞춤]: 지금 화면 가운데가 실제로는 방위 trueAz(도)라고 알려 줌 → 보정값에 반영. */
  alignTo(trueAz) {
    const now = cameraAzEl(this.q).az;
    const d = -wrapPi((trueAz - now) * D2R); // 세계 z축 회전은 반시계 + → 방위(시계 +)와 부호 반대
    this.userYaw = wrapPi(this.userYaw + d);
    this.q = this.rotateYaw(this.q, d);
    this.lastInnov = null;
  }

  /** 손으로 끌어 방향 미세 조정: 카메라 방위를 deg(도)만큼 시계 방향으로. 나침반 기준에도 반영돼 유지된다. */
  nudge(deg) {
    const d = -deg * D2R;
    this.userYaw = wrapPi(this.userYaw + d);
    this.q = this.rotateYaw(this.q, d);
    this.lastInnov = null;
  }

  resetAlignment() { this.userYaw = 0; this.lastInnov = null; this.startT = this.now(); }
}

/** 나침반 지연 후보(ms). */
const LAGS = [0, 16, 33, 50, 66, 83, 100, 133, 166, 200];

/** q ⊗ exp(½ω·dt): 기기 좌표 각속도 ω(rad/s)로 dt초 회전. */
function integrate(q, w, dt) {
  const ang = Math.hypot(w[0], w[1], w[2]) * dt;
  if (ang < 1e-12) return q;
  const s = Math.sin(ang / 2) * dt / ang;
  return qnorm(qmul(q, [Math.cos(ang / 2), w[0] * s, w[1] * s, w[2] * s]));
}

/** 가속도(위 방향)만으로 기울기 자세(방위는 북=화면 위 가정). */
function tiltOnly(a) {
  // 세계 위(0,0,1)를 기기에서 a로 보이게 하는 최소 회전의 역
  const [x, y, z] = a; // 기기에서 본 위 방향
  const c = z, ax = [y, -x, 0], s = Math.hypot(ax[0], ax[1]);
  if (s < 1e-6) return c > 0 ? [1, 0, 0, 0] : [0, 1, 0, 0];
  const ang = Math.atan2(s, c);
  return qaxis(ax[0] / s, ax[1] / s, 0, ang);
}
