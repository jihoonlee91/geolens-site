// 지오렌즈 웹: 카메라 + GPS(칼만) + 자이로·가속도계·나침반(상보 필터)로 산봉우리 이름을 화면에 띄운다.
import { OrientationFilter, qFromEuler, qmul, qaxis, qrot, qrotInv, qnorm, cameraAzEl } from './fusion.js';
import { GpsFilter, MotionDetector } from './gps.js';
import { haversine, bearing, elevationAngle, dirFromAzEl, formatDist, bearingName, geoid, sunAltAz, nextSunEvent, wrap180, D2R } from './geo.js';
import * as terrain from './terrain.js';
import { Book, listNames, famousName as famousKo } from './book.js';
import { romanize } from './hangul.js';
const famousName = f => (EN ? romanize(famousKo(f)) : famousKo(f));

// ───────── 설정·언어 ─────────
const params = new URLSearchParams(location.search);
const store = { get: (k, d) => { try { const v = localStorage.getItem('geolens.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('geolens.' + k, JSON.stringify(v)); } catch { } } };
let EN = params.get('lang') ? params.get('lang') === 'en' : store.get('lang', null) != null ? store.get('lang') === 'en' : !(navigator.language || 'ko').startsWith('ko');
const T = (ko, en) => (EN ? en : ko);
const DATA = 'data';
const PEAK_RADIUS = 40000;
const settings = { fov: store.get('fov', 67), hideOccluded: store.get('hideOccluded', true) };

// ───────── 상태 ─────────
const filter = new OrientationFilter();
const gps = new GpsFilter(), motion = new MotionDetector();
const book = new Book();
let observer = null;            // {lat, lon, alt, acc}
let peaks = [];                 // {id, name, ele, lat, lon, az, el, dist, occ}
let target = null;              // 화살표 안내 대상
let sensorMode = 'none';        // 'imu' | 'compass' | 'sim'
let simLook = { az: 0, el: 3 }; // PC·시험용 시선
let gpsMsl = NaN, gpsAltAcc = Infinity, lastFix = 0, locIssue = null;
let sun = null, sunEvent = null;
const placed = [];              // 이번 프레임에 그린 라벨(누르기 판정)
let screenAngle = 0;

const $ = s => document.querySelector(s);
const cam = $('#cam'), cv = $('#view'), g = cv.getContext('2d');

// ───────── 시작 ─────────
function i18n(root = document) { root.querySelectorAll('[data-ko]').forEach(el => { el.innerHTML = EN ? el.dataset.en : el.dataset.ko; }); }
i18n();
document.documentElement.lang = EN ? 'en' : 'ko';

const isStandalone = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

$('#start').onclick = () => { store.set('started', true); start(); };

async function start() {
  $('#welcome').hidden = true;
  // iOS: 센서 권한은 버튼 누름 안에서 요청해야 함
  try { if (typeof DeviceMotionEvent?.requestPermission === 'function') await DeviceMotionEvent.requestPermission(); } catch { }
  try { if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch { }
  startCamera(); startSensors(); startLocation(); loadFamous();
  try { screen.orientation?.lock?.('portrait').catch(() => { }); } catch { }
  requestAnimationFrame(frame);
  setInterval(slowTick, 2000);
}

async function startCamera() {
  if (params.get('nocam')) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    cam.srcObject = s; await cam.play().catch(() => { });
  } catch (e) { toast(T('카메라를 켤 수 없어요 — 권한을 확인해 주세요. 라벨은 그대로 보여요', 'Camera unavailable — check permission. Labels still work'), 5); }
}

// ───────── 센서: 자이로·가속도계·나침반 ─────────
let accSign = 0, accVotes = 0;
function startSensors() {
  const sim = params.get('look');
  if (sim) { const [a, e] = sim.split(',').map(Number); simLook = { az: a || 0, el: e || 0 }; sensorMode = 'sim'; }
  const onAbs = e => {
    if (e.alpha == null) return;
    filter.setReference(qFromEuler(e.alpha, e.beta, e.gamma));
    if (sensorMode === 'none' || sensorMode === 'sim' && !sim) sensorMode = 'compass';
  };
  if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', onAbs);
  else addEventListener('deviceorientation', e => { // iOS: 나침반 방위(webkitCompassHeading)로 절대 방향
    if (e.webkitCompassHeading == null || e.alpha == null) return;
    filter.setReference(qFromEuler(360 - e.webkitCompassHeading, e.beta, e.gamma), e.webkitCompassAccuracy);
    if (sensorMode === 'none') sensorMode = 'compass';
  });
  addEventListener('devicemotion', e => {
    const r = e.rotationRate, a = e.accelerationIncludingGravity;
    if (!r || r.alpha == null || !a || a.x == null) return;
    let dt = e.interval || 16; dt = dt > 1 ? dt / 1000 : dt; // 크롬은 ms, 예전 iOS는 초
    let acc = [a.x, a.y, a.z];
    // 가속도 부호(기기마다 다를 수 있음): 나침반 기울기와 비교해 처음 30번으로 정함
    if (accVotes < 30 && filter.ref) {
      const up = qrotInv(filter.ref, [0, 0, 1]), n = Math.hypot(...acc) || 1;
      accSign += Math.sign((up[0] * acc[0] + up[1] * acc[1] + up[2] * acc[2]) / n); accVotes++;
    }
    if (accVotes >= 30 && accSign < 0) acc = acc.map(x => -x);
    filter.update([r.beta * D2R, r.gamma * D2R, r.alpha * D2R], accVotes >= 30 || !filter.ref ? acc : null, dt);
    const lin = e.acceleration && e.acceleration.x != null ? [e.acceleration.x, e.acceleration.y, e.acceleration.z] : [0, 0, Math.hypot(...acc) - 9.81];
    motion.push(lin, dt);
    if (sensorMode !== 'sim' || !sim) sensorMode = 'imu';
  });
  // 센서가 없는 PC: 끌어서 둘러보기
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, az: simLook.az, el: simLook.el, moved: false }; });
  addEventListener('pointermove', e => {
    if (!drag || sensorMode === 'imu' || sensorMode === 'compass') return;
    const k = settings.fov / innerHeight, dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) drag.moved = true;
    simLook = { az: (drag.az - dx * k + 360) % 360, el: Math.max(-80, Math.min(80, drag.el + dy * k)) };
    if (sensorMode === 'none') sensorMode = 'sim';
  });
  addEventListener('pointerup', e => { if (drag && !drag.moved) onTap(e.clientX, e.clientY); drag = null; });
  const so = () => { screenAngle = (screen.orientation?.angle ?? window.orientation ?? 0) || 0; };
  so(); screen.orientation?.addEventListener?.('change', so); addEventListener('orientationchange', so);
}

/** 카메라 자세(기기→세계, 화면 회전 반영). */
function cameraQ() {
  if (sensorMode === 'sim' || sensorMode === 'none') {
    const up = qaxis(1, 0, 0, Math.PI / 2);
    return qnorm(qmul(qaxis(0, 0, 1, -simLook.az * D2R), qmul(up, qaxis(1, 0, 0, simLook.el * D2R))));
  }
  return qmul(filter.q, qaxis(0, 0, 1, screenAngle * D2R));
}

// ───────── 위치: GPS + 칼만 필터 ─────────
function startLocation() {
  const sim = params.get('sim');
  if (sim) { const [la, lo] = sim.split(',').map(Number); setObserver(la, lo, 8); return; }
  if (!navigator.geolocation) { locIssue = T('이 브라우저는 위치를 지원하지 않아요', 'Location not supported'); return; }
  navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    if (c.altitude != null && c.altitudeAccuracy != null) { gpsMsl = c.altitude - geoid(c.latitude, c.longitude); gpsAltAcc = c.altitudeAccuracy; }
    if (!gps.update(c.latitude, c.longitude, c.accuracy, p.timestamp || Date.now(), motion.level)) return;
    const f = gps.position();
    lastFix = Date.now(); locIssue = null;
    setObserver(f.lat, f.lon, Math.max(f.accuracy, Math.min(c.accuracy, 15)));
  }, err => {
    locIssue = err.code === 1 ? T('위치 권한이 필요해요 — 주소창 자물쇠 → 권한에서 위치 허용', 'Location permission needed — allow it in site settings')
      : T('위치를 찾는 중… 하늘이 보이는 곳에서 잠시 기다려 주세요', 'Finding your location… wait somewhere with open sky');
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

let lastGeo = null, lastTiles = null, demReady = false;
function setObserver(lat, lon, acc) {
  const ground = terrain.elevation(lat, lon);
  let alt = Number.isFinite(ground) ? ground + 1.6 : (Number.isFinite(gpsMsl) ? gpsMsl : 50);
  if (Number.isFinite(ground) && gpsAltAcc < 12 && gpsMsl - ground > 30) alt = gpsMsl; // 건물 옥상·전망대
  observer = { lat, lon, alt, acc };
  if (!lastTiles || haversine(lat, lon, lastTiles.lat, lastTiles.lon) > 5000) { lastTiles = { lat, lon }; loadPeaks(lat, lon); loadDem(lat, lon); }
  if (!lastGeo || haversine(lat, lon, lastGeo.lat, lastGeo.lon) > 15 || Math.abs(alt - lastGeo.alt) > 5) { lastGeo = { lat, lon, alt }; recomputeGeo(); }
}

async function loadDem(lat, lon) {
  await terrain.ensureArea(lat, lon, PEAK_RADIUS);
  demReady = true;
  if (observer) { const o = observer; lastGeo = null; setObserver(o.lat, o.lon, o.acc); }
}

// ───────── 봉우리 자료(정적 타일: data/nature/{위도칸}_{경도칸}.json, 0.5°) ─────────
let dataVersion = null;
async function loadPeaks(lat, lon) {
  if (!dataVersion) dataVersion = await fetch(`${DATA}/meta.json`).then(r => r.json()).then(m => m.generated).catch(() => '0');
  const step = 0.5, dLat = PEAK_RADIUS / 111000, dLon = PEAK_RADIUS / (111000 * Math.cos(lat * D2R));
  const jobs = [];
  for (let a = Math.floor((lat - dLat) / step); a <= Math.floor((lat + dLat) / step); a++)
    for (let b = Math.floor((lon - dLon) / step); b <= Math.floor((lon + dLon) / step); b++)
      jobs.push(fetch(`${DATA}/nature/${a}_${b}.json?v=${encodeURIComponent(dataVersion)}`).then(r => (r.ok ? r.json() : { elements: [] })).catch(() => ({ elements: [] })));
  const docs = await Promise.all(jobs), out = [], seen = new Set();
  for (const d of docs) for (const el of d.elements || []) {
    const t = el.tags || {};
    if (t.natural !== 'peak' && t.natural !== 'volcano') continue;
    const name = t['name:ko'] || t.name; if (!name) continue;
    const plat = el.lat ?? el.center?.lat, plon = el.lon ?? el.center?.lon; if (plat == null) continue;
    const key = name + Math.round(plat * 500) + Math.round(plon * 500); if (seen.has(key)) continue; seen.add(key);
    const ele = parseFloat(String(t.ele || '').replace(',', '.'));
    out.push({ id: `osm:${el.type}/${el.id}`, name, nameEn: t['name:en'], ele: Number.isFinite(ele) ? ele : NaN, lat: plat, lon: plon });
  }
  peaks = out; lastGeo = null; if (observer) setObserver(observer.lat, observer.lon, observer.acc);
}

async function loadFamous() {
  try { book.setFamous(await fetch(`${DATA}/collections/famous.json`).then(r => r.json())); } catch { }
}

const shown = p => (!EN ? p.name : p.nameEn || romanize(p.name));

// 거리·방향·올려볼 각 + 지형 가림(점진 계산)
let occQueue = [];
function recomputeGeo() {
  if (!observer) return;
  const o = observer;
  for (const p of peaks) {
    p.dist = haversine(o.lat, o.lon, p.lat, p.lon);
    p.az = bearing(o.lat, o.lon, p.lat, p.lon);
    const alt = Number.isFinite(p.ele) ? p.ele : terrain.elevation(p.lat, p.lon);
    p.alt = Number.isFinite(alt) ? alt : o.alt;
    p.el = elevationAngle(p.dist, p.alt - o.alt);
    p.occ = undefined;
  }
  occQueue = peaks.filter(p => p.dist < PEAK_RADIUS && p.dist > 1200).sort((a, b) => a.dist - b.dist);
  const now = new Date();
  sun = sunAltAz(now, o.lat, o.lon);
  sunEvent = nextSunEvent(now, o.lat, o.lon);
}
function processOcclusion(budgetMs) {
  if (!demReady || !observer) return;
  const t0 = performance.now();
  while (occQueue.length && performance.now() - t0 < budgetMs) {
    const p = occQueue.shift();
    p.occ = terrain.occluded(observer.lat, observer.lon, observer.alt, p.lat, p.lon, p.alt, p.dist);
  }
}

// 2초마다: 정상 인증 판정, 해 위치 갱신
function slowTick() {
  if (observer && sensorMode !== 'sim' && !params.get('sim')) {
    const f = gps.position();
    if (f && Date.now() - lastFix < 10000) book.tick(f.lat, f.lon, f.accuracy, peaks, gpsAltAcc < 20 ? gpsMsl : NaN);
  }
  if (observer) { sun = sunAltAz(new Date(), observer.lat, observer.lon); if (sunEvent && sunEvent.time < new Date()) sunEvent = nextSunEvent(new Date(), observer.lat, observer.lon); }
}

// ───────── 그리기 ─────────
let W = 0, H = 0, DPR = 1;
function resize() { DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; cv.width = W * DPR; cv.height = H * DPR; }
addEventListener('resize', resize); resize();

/** 화면 초점거리(CSS px): 카메라 긴 변 화각(settings.fov) + object-fit: cover 확대 반영. */
function focal() {
  const vw = cam.videoWidth, vh = cam.videoHeight;
  if (vw && vh) { const fv = Math.max(vw, vh) / 2 / Math.tan(settings.fov / 2 * D2R); return fv * Math.max(W / vw, H / vh); }
  return Math.max(W, H) / 2 / Math.tan(settings.fov / 2 * D2R);
}

function project(q, f, az, el) {
  const c = qrotInv(q, dirFromAzEl(az, el));
  if (c[2] >= -0.02) return null;
  return [W / 2 + f * c[0] / -c[2], H / 2 - f * c[1] / -c[2]];
}

const COL = { peak: '#73d973', sun: '#ffd04d', gold: '#e8c987' };
function frame() {
  requestAnimationFrame(frame);
  processOcclusion(4);
  draw(false);
  updateGuide();
  updateStatus();
}

function draw(shareMode) {
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!shareMode) { const gr = g.createLinearGradient(0, 0, 0, 160); gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, 160); }
  const q = cameraQ(), f = focal(), look = cameraAzEl(q);
  placed.length = 0;
  if (!observer) { if (!shareMode) drawTape(look); return; }

  // 후보: 봉우리(범위 안, 안 가림) + 해 + 해돋이/해넘이 + 안내 대상
  const cands = [];
  const center = [W / 2, H / 2];
  for (const p of peaks) {
    if (p.dist == null) continue;
    const isT = target && target.id === p.id;
    if (!isT && (p.dist > PEAK_RADIUS || (settings.hideOccluded && p.dist > 1200 && p.occ !== false && demReady && p.occ !== null))) continue;
    if (Math.abs(wrap180(p.az - look.az)) > 80 && !isT) continue;
    const s = project(q, f, p.az, p.el); if (!s) continue;
    if (s[0] < -40 || s[0] > W + 40 || s[1] < -40 || s[1] > H + 40) continue;
    const famous = book.isFamous(p.id);
    const score = 55 + Math.min(15, (p.ele || 0) / 120) - Math.log10(p.dist + 10) * 6 + (famous ? 10 : 0) + (isT ? 1000 : 0);
    cands.push({ kind: 'peak', p, s, score, famous, summit: book.isSummited(p.id) });
  }
  const onScreen = s => s && s[0] > -40 && s[0] < W + 40 && s[1] > -40 && s[1] < H + 40;
  if (sun && sun.alt > -1) { const s = project(q, f, sun.az, sun.alt); if (onScreen(s)) cands.push({ kind: 'sun', s, score: 70, title: T('해', 'Sun'), sub: `${T('고도', 'alt')} ${sun.alt.toFixed(0)}°` }); }
  if (sunEvent) {
    const s = project(q, f, sunEvent.az, -0.27);
    const hh = sunEvent.time.toLocaleTimeString(EN ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const left = (sunEvent.time - new Date()) / 60000;
    if (onScreen(s)) cands.push({ kind: 'sunev', s, score: 62, title: sunEvent.rise ? T(`해돋이 ${hh}`, `Sunrise ${hh}`) : T(`해넘이 ${hh}`, `Sunset ${hh}`),
      sub: left < 60 ? T(`${Math.round(left)}분 뒤`, `in ${Math.round(left)} min`) : T(`${Math.floor(left / 60)}시간 ${Math.round(left % 60)}분 뒤`, `in ${Math.floor(left / 60)} h ${Math.round(left % 60)} min`) });
  }
  cands.sort((a, b) => b.score - a.score);

  const top = shareMode ? 40 : 140, bottom = H - (shareMode ? 150 : (target ? 200 : 130));
  const rects = []; let nPeak = 0;
  g.textBaseline = 'alphabetic';
  for (const c of cands) {
    if (placed.length >= 24) break;
    if (c.kind === 'peak' && nPeak >= 12 && !(target && target.id === c.p.id)) continue;
    const title = c.kind === 'peak' ? clip(shown(c.p), EN ? 26 : 14) : c.title;
    const sub = c.kind === 'peak' ? `${formatDist(c.p.dist)}${Number.isFinite(c.p.ele) ? ' · ' + T(`해발 ${Math.round(c.p.ele).toLocaleString()} m`, `${Math.round(c.p.ele).toLocaleString()} m`) : ''}${c.famous ? T(' · 100대 명산', ' · Top 100') : ''}` : c.sub;
    g.font = '700 15px system-ui, sans-serif'; const tw = g.measureText(title).width;
    g.font = '12px system-ui, sans-serif'; const sw = g.measureText(sub).width;
    const w = Math.max(tw, sw) + 56, h = 44;
    let r = null;
    for (let k = 0; k < 4 && !r; k++) {
      const y = c.s[1] - 18 - h - k * (h + 6), x = Math.max(6, Math.min(W - w - 6, c.s[0] - w / 2));
      const cand = { x, y, w, h };
      if (y < top || y + h > bottom) continue;
      if (rects.some(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y)) continue;
      r = cand;
    }
    if (!r) continue;
    rects.push(r);
    if (c.kind === 'peak') nPeak++;
    const focused = Math.hypot(c.s[0] - center[0], c.s[1] - center[1]) < W * 0.12 || (target && c.p && target.id === c.p.id);
    const col = c.kind === 'peak' ? (c.summit ? COL.gold : COL.peak) : COL.sun;
    // 핀·지시선
    g.strokeStyle = focused ? 'rgba(232,201,135,.85)' : 'rgba(255,255,255,.4)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(c.s[0], c.s[1] - 5); g.lineTo(c.s[0], r.y + h); g.stroke();
    g.fillStyle = focused ? COL.gold : 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(c.s[0], c.s[1], 5, 0, 7); g.fill();
    g.fillStyle = col; g.beginPath(); g.arc(c.s[0], c.s[1], 3, 0, 7); g.fill();
    // 라벨
    g.fillStyle = focused ? 'rgba(23,22,18,.86)' : 'rgba(14,16,22,.68)';
    roundRect(r.x, r.y, w, h, 14); g.fill();
    g.strokeStyle = focused ? 'rgba(232,201,135,.85)' : 'rgba(255,255,255,.14)'; g.lineWidth = 1; roundRect(r.x + .5, r.y + .5, w - 1, h - 1, 14); g.stroke();
    g.fillStyle = hexA(col, .22); g.beginPath(); g.arc(r.x + 22, r.y + h / 2, 14, 0, 7); g.fill();
    icon(c.kind === 'peak' ? (c.summit ? 'check' : 'peak') : 'sun', r.x + 22, r.y + h / 2, col);
    g.fillStyle = 'rgba(255,255,255,.96)'; g.font = '700 15px system-ui, sans-serif'; g.fillText(title, r.x + 44, r.y + 20);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '12px system-ui, sans-serif'; g.fillText(sub, r.x + 44, r.y + 36);
    placed.push({ ...r, c });
  }
  if (!shareMode) { drawTape(look); drawCrosshair(); drawArrow(q, f); }
}

function clip(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function roundRect(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function icon(kind, x, y, col) {
  g.save(); g.translate(x, y); g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  if (kind === 'peak') { g.moveTo(-9, 6); g.lineTo(-2, -6); g.lineTo(2, 0); g.lineTo(4, -3); g.lineTo(9, 6); g.closePath(); g.fill(); }
  else if (kind === 'check') { g.moveTo(-7, 0); g.lineTo(-2, 5); g.lineTo(7, -5); g.stroke(); }
  else { g.arc(0, 0, 5, 0, 7); g.fill(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.moveTo(Math.cos(a) * 7.5, Math.sin(a) * 7.5); g.lineTo(Math.cos(a) * 10, Math.sin(a) * 10); } g.stroke(); }
  g.restore();
}

function drawTape(look) {
  const y = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0) + 12, h = 44, x0 = 12, x1 = W - 12;
  g.fillStyle = 'rgba(14,16,22,.66)'; roundRect(x0, y, x1 - x0, h, 16); g.fill();
  g.save(); g.beginPath(); g.rect(x0 + 6, y, x1 - x0 - 12, h); g.clip();
  const ppd = (x1 - x0) / 100, labels = EN ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] : ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  for (let d = Math.floor((look.az - 50) / 5) * 5; d <= look.az + 50; d += 5) {
    const dd = ((d % 360) + 360) % 360, x = W / 2 + (d - look.az) * ppd, card = dd % 45 === 0, major = dd % 15 === 0;
    g.fillStyle = dd === 0 ? '#ff6b61' : `rgba(255,255,255,${card ? .85 : major ? .45 : .25})`;
    g.fillRect(x - (card ? 1.2 : .8), y + h - (card ? 12 : major ? 8 : 5) - 4, card ? 2.4 : 1.6, card ? 12 : major ? 8 : 5);
    if (card || major) { g.font = `${card ? 700 : 400} ${card ? 13 : 10}px system-ui`; g.textAlign = 'center'; g.fillStyle = dd === 0 ? '#ff6b61' : card ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.4)'; g.fillText(card ? labels[dd / 45] : dd, x, y + 22); }
  }
  g.restore(); g.textAlign = 'left';
  g.fillStyle = COL.gold; g.fillRect(W / 2 - 1.5, y + h - 16, 3, 14);
}

function drawCrosshair() {
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2; g.beginPath(); g.arc(W / 2, H / 2, 11, 0, 7); g.stroke();
  g.fillStyle = COL.gold; g.beginPath(); g.arc(W / 2, H / 2, 2.5, 0, 7); g.fill();
}

// 안내 대상이 화면 밖이면 가장자리에 화살표
function drawArrow(q, f) {
  if (!target) return;
  const c = qrotInv(q, dirFromAzEl(target.az, target.el));
  const s = c[2] < 0 ? [W / 2 + f * c[0] / -c[2], H / 2 - f * c[1] / -c[2]] : null;
  if (s && s[0] > W * .08 && s[0] < W * .92 && s[1] > H * .2 && s[1] < H * .8) return;
  let vx = c[0], vy = -c[1]; const n = Math.hypot(vx, vy) || 1; vx /= n; vy /= n;
  const hw = W / 2 - 50, hh = H / 2 - 170, k = Math.min(hw / Math.max(1e-4, Math.abs(vx)), hh / Math.max(1e-4, Math.abs(vy)));
  const x = W / 2 + vx * k, y = H / 2 + vy * k, sc = 1 + 0.07 * Math.sin(performance.now() / 200);
  g.save(); g.translate(x, y); g.scale(sc, sc);
  g.fillStyle = 'rgba(12,12,16,.75)'; g.beginPath(); g.arc(0, 0, 30, 0, 7); g.fill();
  g.strokeStyle = 'rgba(232,201,135,.8)'; g.lineWidth = 2; g.stroke();
  g.rotate(Math.atan2(vy, vx)); g.fillStyle = COL.gold; g.beginPath(); g.moveTo(18, 0); g.lineTo(-4, -14); g.lineTo(-4, -6); g.lineTo(-14, -6); g.lineTo(-14, 6); g.lineTo(-4, 6); g.lineTo(-4, 14); g.closePath(); g.fill();
  g.restore();
}

function updateGuide() {
  const el = $('#guide');
  if (!target) { el.hidden = true; return; }
  el.hidden = false;
  const look = cameraAzEl(cameraQ()), d = wrap180(target.az - look.az);
  const turn = Math.abs(d) > 150 ? T('뒤로 돌아보세요', 'Turn around') : Math.abs(d) < 12 ? T('화면 가운데쯤', 'Straight ahead') : d > 0 ? T(`오른쪽으로 ${d.toFixed(0)}°`, `${d.toFixed(0)}° right`) : T(`왼쪽으로 ${(-d).toFixed(0)}°`, `${(-d).toFixed(0)}° left`);
  el.querySelector('.gt').textContent = target.title;
  el.querySelector('.gs').textContent = `${target.dist != null ? formatDist(target.dist) + ' · ' : ''}${turn}`;
}
$('#guide .x').onclick = () => { target = null; };
$('#guide').onclick = e => { if (e.target.classList.contains('x')) return; const p = peaks.find(x => x.id === target?.id); if (p) openPeak(p); };

let statusText = '';
function updateStatus() {
  let s = '';
  if (locIssue) s = locIssue;
  else if (!observer) s = T('위치를 찾는 중…', 'Finding your location…');
  else if (sensorMode === 'none') s = T('방향 센서를 기다리는 중… (PC는 화면을 끌어 둘러보기)', 'Waiting for motion sensors… (drag to look around on PC)');
  else if (sensorMode === 'imu' && filter.trust < 0.35) s = T('주변 자기장 간섭 — 자이로로 유지 중, 8자로 흔들어 주세요', 'Magnetic interference — holding with gyro; wave in a figure 8');
  else if (observer.acc > 50 && !params.get('sim')) s = T(`GPS 정확도 낮음(±${Math.round(observer.acc)} m)`, `Low GPS accuracy (±${Math.round(observer.acc)} m)`);
  else if (!peaks.length) s = T('주변 봉우리를 불러오는 중…', 'Loading nearby peaks…');
  if (s !== statusText) { statusText = s; const el = $('#status'); el.hidden = !s; el.textContent = s; }
}

// ───────── 누르기·정보 시트 ─────────
function onTap(x, y) {
  if (!$('#sheet').hidden || !$('#panel').hidden) return;
  for (let i = placed.length - 1; i >= 0; i--) {
    const r = placed[i];
    if (x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 6 && y <= r.y + r.h + 6) {
      if (r.c.kind === 'peak') { book.markSeen(r.c.p); openPeak(r.c.p); }
      else if (r.c.kind === 'sunev') openSunEvent();
      return;
    }
  }
}

function sheet(html) { const s = $('#sheet'); s.innerHTML = html + `<button class="x" aria-label="닫기">×</button>`; s.hidden = false; s.querySelector('.x').onclick = closeSheet; return s; }
function closeSheet() { $('#sheet').hidden = true; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = iso => new Date(iso).toLocaleDateString(EN ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

function openPeak(p) {
  const fam = book.famousFor(p), e = book.entries.get(p.id) || (fam ? book.entryFor(fam) : null);
  const state = e?.summit ? T(`정상 인증 ${fmtDate(e.summit)}`, `Summited ${fmtDate(e.summit)}`) + (e.times > 1 ? T(` · ${e.times}번 오름`, ` · ${e.times} times`) : '')
    : e ? T('담았어요 — 정상 70 m 안에 서면 자동으로 정상 인증', 'Collected — stand within 70 m of the top to verify')
      : fam ? T('아직 못 본 명산 — 화면에 뜬 라벨을 누르면 담겨요', 'Not seen yet — tap its label in view to collect') : '';
  const info = [];
  if (state) info.push([T('도감', 'Collection'), state]);
  if (fam && famousName(fam) !== p.name) info.push([T('명산', 'Mountain'), famousName(fam)]);
  if (p.occ) info.push([T('보임', 'View'), T('앞산에 가려 안 보여요', 'Hidden behind a nearer hill')]);
  if (EN && p.nameEn) info.push(['Korean', p.name]);
  const s = sheet(`<h3>${esc(shown(p))}</h3><div class="sub">${T('산봉우리', 'Peak')}${fam ? ' · ' + esc(listNames(book, fam, EN)) : ''}</div>
    <div class="stats"><div class="stat"><small>${T('거리', 'Distance')}</small><b>${formatDist(p.dist)}</b></div>
    <div class="stat"><small>${T('방향', 'Direction')}</small><b>${bearingName(p.az, EN)} ${Math.round(p.az)}°</b></div>
    <div class="stat"><small>${T('해발', 'Elevation')}</small><b>${Number.isFinite(p.ele) ? Math.round(p.ele).toLocaleString() + ' m' : '–'}</b></div></div>
    <div class="info">${info.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>
    <div class="btns"><button class="p" data-a="guide">${T('따라가기', 'Guide me')}</button><button data-a="align">${T('방향 맞춤', 'Align')}</button>
    <button data-a="map">${T('지도', 'Map')}</button><button data-a="route">${T('길찾기', 'Directions')}</button></div>`);
  s.querySelector('[data-a=guide]').onclick = () => { target = { id: p.id, az: p.az, el: p.el, dist: p.dist, title: shown(p) }; closeSheet(); toast(T(`'${shown(p)}' 쪽으로 화살표를 따라가 보세요`, `Follow the arrow to '${shown(p)}'`)); };
  s.querySelector('[data-a=align]').onclick = () => { if (sensorMode === 'sim') simLook.az = p.az; else filter.alignTo(p.az); closeSheet(); toast(T(`'${shown(p)}' 기준으로 방향을 맞췄어요 — 화면 가운데에 그 산을 두고 누르세요`, `Aligned to '${shown(p)}' — center that peak first`), 3); };
  s.querySelector('[data-a=map]').onclick = () => open(`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`, '_blank');
  s.querySelector('[data-a=route]').onclick = () => open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=walking`, '_blank');
}

function openSunEvent() {
  const ev = sunEvent; if (!ev) return;
  const s = sheet(`<h3>${ev.rise ? T('해돋이', 'Sunrise') : T('해넘이', 'Sunset')} ${ev.time.toLocaleTimeString(EN ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}</h3>
    <div class="sub">${bearingName(ev.az, EN)} ${Math.round(ev.az)}° · ${T('지평선 기준(산에 가리면 조금 늦어요)', 'on the horizon (later behind hills)')}</div>
    <div class="btns"><button class="p" data-a="guide">${T('따라가기', 'Guide me')}</button></div>`);
  s.querySelector('[data-a=guide]').onclick = () => { target = { id: 'sun', az: ev.az, el: -0.27, title: ev.rise ? T('해돋이', 'Sunrise') : T('해넘이', 'Sunset') }; closeSheet(); };
}

// ───────── 정상 인증 ─────────
book.onSummit = (h, e) => {
  const name = h.famous ? famousName(h.famous) : (EN ? romanize(h.name) : h.name);
  const lines = h.famous ? book.lists.filter(l => h.famous.lists.includes(l.key)).map(l => { const p = book.progress(l.key); return `${EN ? l.titleEn : l.title}   ${p.summit} / ${p.total}`; }) : [];
  lines.push(T(`내가 오른 봉우리 ${book.summitCount}곳`, `Summits so far: ${book.summitCount}`));
  const s = sheet(`<h3>${e.times > 1 ? T(`${esc(name)} — ${e.times}번째 정상`, `${esc(name)} — summit #${e.times}`) : T(`${esc(name)} 정상 인증`, `Summit: ${esc(name)}`)}</h3>
    <div class="sub">${h.ele ? T(`해발 ${Math.round(h.ele).toLocaleString()} m · `, `${Math.round(h.ele).toLocaleString()} m · `) : ''}${new Date().toLocaleString(EN ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}</div>
    <div class="info">${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    <div class="btns"><button class="p" data-a="shot">${T('정상 사진 남기기', 'Summit photo')}</button><button data-a="book">${T('도감 보기', 'Collection')}</button></div>`);
  s.querySelector('[data-a=shot]').onclick = () => { closeSheet(); shareShot(T(`${name} 정상`, `${name} summit`) + (h.ele ? ` · ${Math.round(h.ele).toLocaleString()} m` : '')); };
  s.querySelector('[data-a=book]').onclick = () => { closeSheet(); showCollection(h.famous ? h.famous.lists[0] : null); };
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
};

// ───────── 도감·설정 패널 ─────────
const SVG = { peak: '<svg class="ic" viewBox="0 0 24 24"><path d="M2 20 9 7l4 6 2-3 7 10z"/></svg>', check: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5" fill="none" stroke="#e8c987" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' };
function panel(title) { const p = $('#panel'); p.querySelector('h2').textContent = title; p.hidden = false; closeSheet(); const b = p.querySelector('.pb'); b.innerHTML = ''; return b; }
$('#panel .x').onclick = () => { $('#panel').hidden = true; };
function row(parent, title, detail, cls, icon, onclick) {
  const b = document.createElement('button'); b.className = 'row ' + (cls || '');
  b.innerHTML = `${SVG[icon] || SVG.peak}<div><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
  if (onclick) b.onclick = onclick; parent.appendChild(b); return b;
}
const sec = (parent, t) => parent.insertAdjacentHTML('beforeend', `<div class="sec">${esc(t)}</div>`);
const note = (parent, t) => parent.insertAdjacentHTML('beforeend', `<div class="note">${esc(t)}</div>`);

function showBook() {
  const b = panel(T('봉우리 도감', 'Peak collection'));
  for (const l of book.lists) { const p = book.progress(l.key); row(b, `${EN ? l.titleEn : l.title}   ${p.summit} / ${p.total}`, T(`정상 인증 ${p.summit}곳 · 본 봉우리 ${p.seen}곳`, `${p.summit} summited · ${p.seen} seen`), '', 'peak', () => showCollection(l.key)); }
  if (!book.lists.length) note(b, T('100대 명산 목록을 불러오는 중이에요.', 'Loading the Top 100 lists…'));
  row(b, T(`내가 본 봉우리 ${book.seenCount}곳`, `Peaks I've seen: ${book.seenCount}`), T(`정상 인증 ${book.summitCount}곳 · 화면에 뜬 산 라벨을 누르면 담겨요`, `${book.summitCount} summited · tap a peak label to collect`), '', 'peak', () => showCollection(null));
}

function showCollection(key) {
  const l = book.lists.find(x => x.key === key);
  const b = panel(l ? (EN ? l.titleEn : l.title) : T('내가 본 봉우리', "Peaks I've seen"));
  const o = observer;
  const detailOf = e => (e.summit ? T(`정상 인증 ${fmtDate(e.summit)}`, `Summited ${fmtDate(e.summit)}`) + (e.times > 1 ? T(` · ${e.times}번`, ` · ×${e.times}`) : '') : T(`본 봉우리 ${fmtDate(e.seen)}`, `Seen ${fmtDate(e.seen)}`));
  const openAt = (id, name, ele, lat, lon) => {
    $('#panel').hidden = true;
    let p = peaks.find(x => x.id === id);
    if (!p) { p = { id, name, ele, lat, lon }; if (o) { p.dist = haversine(o.lat, o.lon, lat, lon); p.az = bearing(o.lat, o.lon, lat, lon); p.el = elevationAngle(p.dist, ele - o.alt); } }
    if (p.dist != null) openPeak(p);
  };
  if (l) {
    const p = book.progress(key);
    note(b, T(`정상 인증 ${p.summit} · 본 봉우리 ${p.seen} · 전체 ${p.total}. 정상 70 m 안에 서면 자동으로 인증돼요.`, `${p.summit} summited · ${p.seen} seen · ${p.total} total. Stand within 70 m of a top to verify.`));
    const rows = book.famous.filter(f => f.lists.includes(key)).map(f => ({ f, e: book.entryFor(f), d: o ? haversine(o.lat, o.lon, f.lat, f.lon) : 0 }));
    const rank = e => (!e ? 2 : e.summit ? 0 : 1);
    rows.sort((a, c) => rank(a.e) - rank(c.e) || (a.e ? ((c.e.last || c.e.seen) > (a.e.last || a.e.seen) ? 1 : -1) : o ? a.d - c.d : a.f.name.localeCompare(c.f.name)));
    for (const r of rows) row(b, `${famousName(r.f)}   ${Math.round(r.f.ele).toLocaleString()} m`, r.e ? detailOf(r.e) : o ? `${formatDist(r.d)} · ${bearingName(bearing(o.lat, o.lon, r.f.lat, r.f.lon), EN)}` : '',
      r.e?.summit ? 'on' : r.e ? 'seen' : '', r.e?.summit ? 'check' : 'peak', () => openAt(r.f.id, famousName(r.f), r.f.ele, r.f.lat, r.f.lon));
  } else {
    const list = book.sorted();
    if (!list.length) note(b, T('화면에 뜬 산 라벨을 누르면 여기에 담겨요. 정상 70 m 안에 서면 자동으로 정상 인증이 돼요.', 'Tap a peak label in view to collect it. Stand within 70 m of a top to verify your summit.'));
    for (const e of list) row(b, `${EN ? romanize(e.name) : e.name}${e.ele ? `   ${Math.round(e.ele).toLocaleString()} m` : ''}`, detailOf(e) + (o ? ` · ${formatDist(haversine(o.lat, o.lon, e.lat, e.lon))}` : ''), e.summit ? 'on' : 'seen', e.summit ? 'check' : 'peak', () => openAt(e.id, e.name, e.ele, e.lat, e.lon));
  }
  if (book.seenCount) { sec(b, T('기록', 'Records')); row(b, T('기록 내보내기 (CSV)', 'Export records (CSV)'), T('엑셀·구글 시트에서 열려요', 'Opens in Excel or Google Sheets'), '', 'peak', exportCsv); }
}

async function exportCsv() {
  const file = new File([book.csv(EN)], `GeoLens_peaks_${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: T('지오렌즈 봉우리 도감', 'GeoLens peak collection') }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  download(file);
}
function download(file) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

function showMenu() {
  const b = panel(T('설정', 'Settings'));
  sec(b, T('앱', 'App'));
  if (deferredInstall) row(b, T('홈 화면에 앱으로 설치', 'Install as an app'), T('주소창 없이 전체 화면으로, 바로 실행', 'Full screen, one tap to open'), '', 'peak', installApp);
  else if (!isStandalone()) note(b, isIOS ? T("아이폰: Safari 공유 버튼 → '홈 화면에 추가'", "iPhone: Safari Share → 'Add to Home Screen'") : T("크롬 메뉴(⋮) → '앱 설치' 또는 '홈 화면에 추가'", "Chrome menu (⋮) → 'Install app'"));
  row(b, '언어 · Language', EN ? 'English → 한국어' : '한국어 → English', '', 'peak', () => { store.set('lang', EN ? 'ko' : 'en'); location.reload(); });
  sec(b, T('방향·화면', 'Direction & view'));
  row(b, T('나침반 다시 맞추기', 'Reset compass alignment'), T('[방향 맞춤]으로 바꾼 보정을 지우고 나침반을 다시 따라가요', 'Clears manual alignment and follows the compass again'), '', 'peak', () => { filter.resetAlignment(); toast(T('폰을 들고 8자를 그려 주세요', 'Wave your phone in a figure 8')); $('#panel').hidden = true; });
  row(b, T('앞산에 가린 봉우리 숨기기', 'Hide peaks behind hills'), settings.hideOccluded ? T('켜짐 — 실제로 보이는 봉우리만', 'On — only visible peaks') : T('꺼짐 — 가려진 봉우리도', 'Off — hidden peaks too'), '', 'peak', () => { settings.hideOccluded = !settings.hideOccluded; store.set('hideOccluded', settings.hideOccluded); showMenu(); });
  b.insertAdjacentHTML('beforeend', `<div class="note">${T('화각(카메라에 맞추기)', 'Field of view (match your camera)')}: <b id="fovv">${settings.fov}°</b><input id="fov" type="range" min="45" max="90" step="1" value="${settings.fov}"><br>${T('산 라벨이 실제 산보다 바깥쪽에 뜨면 줄이고, 안쪽이면 늘리세요.', 'If labels sit outside the real peaks, lower it; inside, raise it.')}</div>`);
  b.querySelector('#fov').oninput = e => { settings.fov = +e.target.value; store.set('fov', settings.fov); b.querySelector('#fovv').textContent = settings.fov + '°'; };
  sec(b, T('센서 상태', 'Sensors'));
  const st = document.createElement('div'); st.className = 'note'; b.appendChild(st);
  const tick = () => {
    if ($('#panel').hidden || !st.isConnected) return;
    const p = gps.position();
    st.innerHTML = [
      `${T('방향', 'Mode')}: ${sensorMode === 'imu' ? T('자이로+가속도계+나침반 융합', 'gyro + accel + compass fusion') : sensorMode === 'compass' ? T('나침반만', 'compass only') : sensorMode}`,
      `${T('자이로', 'Gyro')}: ${filter.gyroHz ? Math.round(filter.gyroHz) + ' Hz' : '–'} · ${T('영점', 'bias')} ${filter.bias.map(x => (x * 57.3).toFixed(2)).join('/')} °/s`,
      `${T('나침반 신뢰도', 'Compass trust')}: ${Math.round(filter.trust * 100)}% · ${T('지연', 'lag')} ${filter.compassLagMs} ms`,
      `GPS: ${p ? `±${Math.round(p.accuracy)} m · ${p.speed.toFixed(1)} m/s` : '–'} · ${T('움직임', 'motion')} ${Math.round(motion.level * 100)}%`,
      `${T('지형', 'Terrain')}: ${terrain.loadedTiles()} ${T('타일', 'tiles')} · ${T('봉우리', 'peaks')} ${peaks.length}`,
    ].join('<br>');
    setTimeout(tick, 500);
  };
  tick();
  sec(b, T('정보', 'About'));
  note(b, '© OpenStreetMap contributors (ODbL) · AWS Terrain Tiles · 산림청·블랙야크 100대 명산 목록');
  b.insertAdjacentHTML('beforeend', `<div class="note"><a href="privacy.html">${T('개인정보처리방침', 'Privacy')}</a> · <a href="https://github.com/jihoonlee91/geolens-site/releases/latest/download/GeoLens.apk">${T('안드로이드 앱(APK)', 'Android app (APK)')}</a></div>`);
}

$('#bBook').onclick = showBook;
$('#bMenu').onclick = showMenu;
$('#bShot').onclick = () => shareShot(null);

// ───────── 사진 공유: 카메라 + 라벨 + 장소·날짜 띠 ─────────
async function shareShot(place) {
  const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
  const x = c.getContext('2d');
  if (cam.videoWidth) { const s = Math.max(W / cam.videoWidth, H / cam.videoHeight), w = cam.videoWidth * s, h = cam.videoHeight * s; x.drawImage(cam, (W - w) / 2 * DPR, (H - h) / 2 * DPR, w * DPR, h * DPR); }
  else { const gr = x.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, '#1a2238'); gr.addColorStop(1, '#07080b'); x.fillStyle = gr; x.fillRect(0, 0, c.width, c.height); }
  draw(true); x.drawImage(cv, 0, 0);
  if (!place) { const pk = placed.find(r => r.c.kind === 'peak' && Math.abs(r.x + r.w / 2 - W / 2) < W * .2) || placed.find(r => r.c.kind === 'peak'); place = pk ? shown(pk.c.p) + (Number.isFinite(pk.c.p.ele) ? T(` · 해발 ${Math.round(pk.c.p.ele).toLocaleString()} m`, ` · ${Math.round(pk.c.p.ele).toLocaleString()} m`) : '') : T('지금 보는 풍경', "What I'm looking at"); }
  x.setTransform(DPR, 0, 0, DPR, 0, 0);
  const gr = x.createLinearGradient(0, H - 200, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.6)'); x.fillStyle = gr; x.fillRect(0, H - 200, W, 200);
  x.fillStyle = '#fff'; x.font = '700 24px system-ui, sans-serif'; x.shadowColor = 'rgba(0,0,0,.8)'; x.shadowBlur = 6; x.fillText(place, 20, H - 62);
  x.font = '14px system-ui, sans-serif'; x.fillStyle = 'rgba(255,255,255,.75)'; x.fillText(new Date().toLocaleString(EN ? 'en-US' : 'ko-KR', { dateStyle: 'long', timeStyle: 'short' }), 20, H - 38);
  x.shadowBlur = 0; x.fillStyle = 'rgba(15,17,23,.85)'; x.beginPath(); x.roundRect?.(W - 122, H - 64, 104, 34, 17); x.fill();
  x.fillStyle = '#e8c987'; x.font = '700 15px system-ui'; x.fillText(T('지오렌즈', 'GeoLens'), W - 104, H - 41);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const file = new File([blob], `GeoLens_${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.jpg`, { type: 'image/jpeg' });
  const text = T(`${place} — 지오렌즈로 봤어요. 비추면 산 이름이 떠요 ▶ ${location.origin}${location.pathname}`, `${place} — seen with GeoLens ▶ ${location.origin}${location.pathname}`);
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  download(file); toast(T('사진을 저장했어요', 'Photo saved'));
}

// ───────── 알림·설치 ─────────
let toastTimer = 0;
function toast(msg, sec = 2.5) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, sec * 1000); }

let deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!isStandalone()) { $('#install').hidden = false; $('#install2').hidden = false; } });
addEventListener('appinstalled', () => { deferredInstall = null; $('#install').hidden = true; $('#install2').hidden = true; toast(T('설치했어요 — 홈 화면의 지오렌즈로 바로 열 수 있어요', 'Installed — open GeoLens from your home screen')); });
async function installApp() { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => { }); deferredInstall = null; $('#install').hidden = true; $('#install2').hidden = true; }
$('#install').onclick = installApp; $('#install2').onclick = installApp;
$('#install').textContent = T('앱 설치', 'Install app');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

// ───────── 첫 화면 또는 바로 시작(모듈의 모든 변수가 준비된 뒤) ─────────
const needsTap = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'; // iOS: 센서 권한은 누름 안에서만
if (params.get('sim') || (store.get('started', false) && !needsTap)) start(); else {
  $('#welcome').hidden = false;
  if (isIOS && !isStandalone()) $('#iosHint').hidden = false;
  // 크롬이 설치 버튼(beforeinstallprompt)을 아직 안 줬으면 메뉴로 설치하는 방법 안내
  else if (!isStandalone()) setTimeout(() => { if (!deferredInstall) $('#andHint').hidden = false; }, 2500);
}

// 시험용(자동 테스트·디버그)
window.geolens = { filter, gps, book, get peaks() { return peaks; }, get observer() { return observer; }, get placed() { return placed; }, openPeak, showBook, showCollection, showMenu, setLook: (az, el) => { sensorMode = 'sim'; simLook = { az, el }; } };
