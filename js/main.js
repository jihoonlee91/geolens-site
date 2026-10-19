// 지오렌즈 웹: 카메라 + GPS(칼만) + 자이로·가속도계·나침반(상보 필터)로 주변을 화면에 띄운다.
// 봉우리 · 산길·계곡·강(선) · 전망대·랜드마크·절 · 산 너머 마을 · 해·달과 그 경로 · 해돋이/해넘이.
import { OrientationFilter, qFromEuler, qmul, qaxis, qrotInv, qnorm, qconj, cameraAzEl } from './fusion.js';
import { GpsFilter, MotionDetector } from './gps.js';
import { haversine, bearing, elevationAngle, dirFromAzEl, formatDist, bearingName, geoid, sunAltAz, nextSunEvent, wrap180, D2R } from './geo.js';
import * as terrain from './terrain.js';
import { Book, listNames, famousName as famousKo } from './book.js';
import { romanize } from './hangul.js';
import { moonAltAz, moonPhaseName, dayPath } from './sky.js';
import { loadLines, loadSights, loadPlaces } from './layers.js';
import { mapApps, openApp, photosNear } from './links.js';
import { planets as planetPos, stars as starPos, FIGURES, loadSatellites, satLook } from './space.js';
const AIR_URL = 'https://jdidzokxoaxqcnraowyu.supabase.co/functions/v1/geolens-air';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpkaWR6b2t4b2F4cWNucmFvd3l1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzOTgzMDQsImV4cCI6MjEwNTk3NDMwNH0.ydRbTO4Ej3zCXAdaG_Djt5rW0SbmmQbGwu8pcgHHunE'; // 공개(anon) 키

// ───────── 설정·언어 ─────────
const params = new URLSearchParams(location.search);
const store = { get: (k, d) => { try { const v = localStorage.getItem('geolens.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('geolens.' + k, JSON.stringify(v)); } catch { } } };
/** 언어: 직접 고른 것 → 휴대폰 언어 목록(한국어가 먼저면 한국어, 다른 언어면 영어) → 없으면 시간대(한국이면 한국어). */
function initialEnglish() {
  const p = params.get('lang'); if (p) return p === 'en';
  const s = store.get('lang', null); if (s) return s === 'en';
  const langs = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  if (langs.length) return !/^ko\b/i.test(langs[0]);
  return Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Seoul';
}
const EN = initialEnglish();
const T = (ko, en) => (EN ? en : ko);
const setLang = en => { store.set('lang', en ? 'en' : 'ko'); location.reload(); };
const famousName = f => (EN ? romanize(famousKo(f)) : famousKo(f));
const shown = p => (!EN ? p.name : p.nameEn || romanize(p.name));
const DATA = 'data';
const PEAK_RADIUS = 40000;
const settings = { fov: store.get('fov', 67), hideOccluded: store.get('hideOccluded', true) };
const LAYERS = ['peaks', 'paths', 'sights', 'sky', 'air', 'xray'];
const layer = Object.assign({ peaks: true, paths: true, sights: true, sky: true, air: true, xray: false }, store.get('layers', {}));

// ───────── 상태 ─────────
const filter = new OrientationFilter();
const gps = new GpsFilter(), motion = new MotionDetector();
const book = new Book();
let observer = null;            // {lat, lon, alt, acc}
let peaks = [], sights = [], places = [], lines = [];
let target = null;              // 화살표 안내 대상 {id, title, lat?, lon?, alt?, az, el, dist}
let sensorMode = 'none';        // 'imu' | 'compass' | 'sim'
let simLook = { az: 0, el: 3 };
let gpsMsl = NaN, gpsAltAcc = Infinity, lastFix = 0, locIssue = null;
let sun = null, moon = null, sunEvent = null, sunPath = [], moonPath = [];
let planetsNow = [], starsNow = new Map(), sats = [], satsNow = [], aircraft = [], airT = 0;
const placed = [];              // 이번 프레임 라벨(누르기 판정)
let prevShown = new Set();      // 직전 프레임 라벨(깜빡임 줄이기)
let screenAngle = 0, dataVersion = null;

const $ = s => document.querySelector(s);
const cam = $('#cam'), cv = $('#view'), g = cv.getContext('2d');
const isStandalone = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function i18n(root = document) { root.querySelectorAll('[data-ko]').forEach(el => { el.innerHTML = EN ? el.dataset.en : el.dataset.ko; }); }
i18n();
document.documentElement.lang = EN ? 'en' : 'ko';
$('#lang').textContent = EN ? '한국어' : 'English';
$('#lang').onclick = () => setLang(!EN);
$('#start').onclick = () => { store.set('started', true); start(); };

let started = false;
async function start() {
  if (started) return; started = true;
  $('#welcome').hidden = true;
  try { if (typeof DeviceMotionEvent?.requestPermission === 'function') await DeviceMotionEvent.requestPermission(); } catch { }
  try { if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission(); } catch { }
  startCamera(); startSensors(); startLocation(); loadFamous(); keepAwake(); buildChips();
  try { screen.orientation?.lock?.('portrait').catch(() => { }); } catch { }
  requestAnimationFrame(frame);
  setInterval(slowTick, 2000);
  handleShared();
}

// 산에서 화면이 꺼지지 않게
let wake = null;
async function keepAwake() { try { wake = await navigator.wakeLock?.request('screen'); } catch { } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) keepAwake(); });

async function startCamera() {
  if (params.get('nocam')) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    cam.srcObject = s; await cam.play().catch(() => { });
  } catch { toast(T('카메라를 켤 수 없어요 — 권한을 확인해 주세요. 라벨은 그대로 보여요', 'Camera unavailable — check permission. Labels still work'), 5); }
}

// ───────── 센서: 자이로·가속도계·나침반 ─────────
let accSign = 0, accVotes = 0;
function startSensors() {
  const sim = params.get('look');
  if (sim) { const [a, e] = sim.split(',').map(Number); simLook = { az: a || 0, el: e || 0 }; sensorMode = 'sim'; }
  const onAbs = e => {
    if (e.alpha == null) return;
    filter.setReference(qFromEuler(e.alpha, e.beta, e.gamma));
    if (sensorMode === 'none') sensorMode = 'compass';
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
    if (!sim) sensorMode = 'imu';
  });
  // 센서가 없는 PC: 끌어서 둘러보기 / 누르면 라벨 열기
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

const last = { geo: null, peaks: null, lines: null, sights: null, places: null };
let demReady = false;
const moved = (k, lat, lon, m) => { if (last[k] && haversine(lat, lon, last[k].lat, last[k].lon) < m) return false; last[k] = { lat, lon }; return true; };

function setObserver(lat, lon, acc) {
  const ground = terrain.elevation(lat, lon);
  let alt = Number.isFinite(ground) ? ground + 1.6 : (Number.isFinite(gpsMsl) ? gpsMsl : 50);
  if (Number.isFinite(ground) && gpsAltAcc < 12 && gpsMsl - ground > 30) alt = gpsMsl; // 건물 옥상·전망대
  observer = { lat, lon, alt, acc };
  if (moved('peaks', lat, lon, 5000)) { loadPeaks(lat, lon); loadDem(lat, lon); }
  if (moved('lines', lat, lon, 700)) withVersion(v => loadLines(DATA, v, lat, lon)).then(l => { lines = l; recomputeLines(); });
  if (moved('sights', lat, lon, 2500)) withVersion(v => loadSights(DATA, v, lat, lon)).then(s => { sights = s; recomputeGeo(); });
  if (moved('places', lat, lon, 8000)) loadPlaces(lat, lon).then(p => { places = p; recomputeGeo(); });
  if (!last.geo || haversine(lat, lon, last.geo.lat, last.geo.lon) > 15 || Math.abs(alt - last.geo.alt) > 5) { last.geo = { lat, lon, alt }; recomputeGeo(); recomputeLines(); }
}

async function withVersion(fn) {
  if (!dataVersion) dataVersion = await fetch(`${DATA}/meta.json`).then(r => r.json()).then(m => m.generated).catch(() => '0');
  return fn(dataVersion);
}

async function loadDem(lat, lon) {
  await terrain.ensureArea(lat, lon, PEAK_RADIUS);
  demReady = true;
  if (observer) { const o = observer; last.geo = null; setObserver(o.lat, o.lon, o.acc); }
}

// 봉우리(정적 타일 data/nature, 0.5°). 같은 이름이 1.5 km 안에 여럿이면(같은 봉우리 중복 입력) 높은 쪽만
async function loadPeaks(lat, lon) {
  const docs = await withVersion(v => {
    const step = 0.5, dLat = PEAK_RADIUS / 111000, dLon = PEAK_RADIUS / (111000 * Math.cos(lat * D2R)), jobs = [];
    for (let a = Math.floor((lat - dLat) / step); a <= Math.floor((lat + dLat) / step); a++)
      for (let b = Math.floor((lon - dLon) / step); b <= Math.floor((lon + dLon) / step); b++)
        jobs.push(fetch(`${DATA}/nature/${a}_${b}.json?v=${encodeURIComponent(v)}`).then(r => (r.ok ? r.json() : { elements: [] })).catch(() => ({ elements: [] })));
    return Promise.all(jobs);
  });
  const out = [], byName = new Map();
  for (const d of docs) for (const el of d.elements || []) {
    const t = el.tags || {};
    if (t.natural !== 'peak' && t.natural !== 'volcano') continue;
    const name = t['name:ko'] || t.name; if (!name) continue;
    const plat = el.lat ?? el.center?.lat, plon = el.lon ?? el.center?.lon; if (plat == null) continue;
    const ele = parseFloat(String(t.ele || '').replace(',', '.'));
    const p = { id: `osm:${el.type}/${el.id}`, kind: 'peak', name, nameEn: t['name:en'], wiki: t.wikipedia, ele: Number.isFinite(ele) ? ele : NaN, lat: plat, lon: plon };
    const same = (byName.get(name) || []).find(q => haversine(q.lat, q.lon, plat, plon) < 1500);
    if (same) { if ((p.ele || 0) > (same.ele || 0) && !book.isFamous(same.id)) Object.assign(same, p); continue; }
    byName.set(name, [...(byName.get(name) || []), p]); out.push(p);
  }
  peaks = out; last.geo = null; if (observer) setObserver(observer.lat, observer.lon, observer.acc);
}

async function loadFamous() { try { book.setFamous(await fetch(`${DATA}/collections/famous.json`).then(r => r.json())); } catch { } }

// 거리·방향·올려볼 각 + 지형 가림(점진 계산)
let occQueue = [];
function locate(p, o, extra = 0) {
  p.dist = haversine(o.lat, o.lon, p.lat, p.lon);
  p.az = bearing(o.lat, o.lon, p.lat, p.lon);
  const ground = Number.isFinite(p.ele) ? p.ele : terrain.elevation(p.lat, p.lon);
  p.alt = (Number.isFinite(ground) ? ground : o.alt - 1.6) + extra;
  p.el = elevationAngle(p.dist, p.alt - o.alt);
}
function recomputeGeo() {
  if (!observer) return;
  const o = observer;
  for (const p of peaks) { locate(p, o); p.occ = undefined; }
  for (const s of sights) { locate(s, o, s.kind === 'building' || s.kind === 'tower' ? (Number.isFinite(s.height) ? s.height * 0.9 : 30) : 4); s.occ = undefined; }
  for (const s of places) { locate(s, o, 10); s.occ = undefined; }
  if (target?.lat != null) locate(target, o, target.extra || 0);
  occQueue = [...peaks.filter(p => p.dist < PEAK_RADIUS && p.dist > 1200), ...sights.filter(s => s.dist > 400), ...places.filter(s => s.dist > 600)].sort((a, b) => a.dist - b.dist);
  updateSky(true);
}
function processOcclusion(budgetMs) {
  if (!demReady || !observer) return;
  const t0 = performance.now();
  while (occQueue.length && performance.now() - t0 < budgetMs) {
    const p = occQueue.shift();
    p.occ = terrain.occluded(observer.lat, observer.lon, observer.alt, p.lat, p.lon, p.alt, p.dist);
  }
}

// 선(산길·물길): 꼭짓점마다 땅 높이 + 방위·고도각·거리
function recomputeLines() {
  if (!observer) return;
  const o = observer;
  for (const l of lines) {
    l.v = l.pts.map(([la, lo]) => {
      const d = haversine(o.lat, o.lon, la, lo), gnd = terrain.elevation(la, lo);
      const az = bearing(o.lat, o.lon, la, lo), el = elevationAngle(Math.max(d, 3), (Number.isFinite(gnd) ? gnd : o.alt - 1.6) + 0.3 - o.alt);
      return { az, el, dist: d, dir: dirFromAzEl(az, el) };
    });
    l.near = Math.min(...l.v.map(v => v.dist));
  }
}

let skyT = 0;
function updateSky(force) {
  if (!observer || (!force && Date.now() - skyT < 30000)) return;
  skyT = Date.now();
  const now = new Date(), o = observer;
  sun = sunAltAz(now, o.lat, o.lon); moon = moonAltAz(now, o.lat, o.lon);
  planetsNow = planetPos(now, o.lat, o.lon); starsNow = starPos(now, o.lat, o.lon);
  sunEvent = nextSunEvent(now, o.lat, o.lon);
  sunPath = dayPath('sun', now, o.lat, o.lon); moonPath = dayPath('moon', now, o.lat, o.lon);
}

// ───────── 비행기·인공위성 ─────────
let satsLoading = false, satT = 0;
/** 1초마다: 위성 위치(SGP4)와 ±5분 하늘 경로(30초마다), 10초마다: 주변 항공기. */
async function airTick() {
  if (!observer || !layer.air) return;
  const now = new Date(), o = observer;
  if (!sats.length && !satsLoading) { satsLoading = true; sats = await loadSatellites().catch(() => []); satsLoading = false; }
  const withPath = Date.now() - satT > 30000; if (withPath) satT = Date.now();
  const out = [];
  for (const s of sats) {
    const l = satLook(s.model, now, o.lat, o.lon, o.alt);
    if (!l || l.alt < 3) continue;
    const prev = satsNow.find(x => x.s === s);
    const path = withPath || !prev ? [-300, -240, -180, -120, -60, 0, 60, 120, 180, 240, 300].map(dt => satLook(s.model, new Date(now.getTime() + dt * 1000), o.lat, o.lon, o.alt)).filter(Boolean) : prev.path;
    out.push({ s, ...l, path });
  }
  satsNow = out;
  if (Date.now() - airT > 10000) {
    airT = Date.now();
    try {
      const j = await (await fetch(`${AIR_URL}?lat=${o.lat.toFixed(2)}&lon=${o.lon.toFixed(2)}`, { headers: { Authorization: 'Bearer ' + ANON, apikey: ANON } })).json();
      if (j.ac) { const t0 = j.t || Date.now(); aircraft = j.ac.filter(a => !a.ground && a.alt > 0).map(a => ({ ...a, t0 })); }
    } catch { }
  }
}
setInterval(() => { if (started) airTick(); }, 1000);

/** 항공기 지금 위치(받은 뒤 지난 시간만큼 속도·방향으로 이어 감)와 방위·고도각·거리. */
function planeNow(a, dtSec = 0) {
  const t = (Date.now() - a.t0) / 1000 + dtSec, v = (a.gs || 0) * 0.5144, tr = (a.trk || 0) * D2R;
  const lat = a.lat + v * t * Math.cos(tr) / 111320, lon = a.lon + v * t * Math.sin(tr) / (111320 * Math.cos(a.lat * D2R));
  const altM = a.alt * 0.3048 + (a.vr || 0) * 0.3048 / 60 * t, d = haversine(observer.lat, observer.lon, lat, lon);
  return { lat, lon, altM, dist: Math.hypot(d, altM - observer.alt), az: bearing(observer.lat, observer.lon, lat, lon), el: elevationAngle(d, altM - observer.alt, 0) };
}

// 2초마다: 정상 인증 판정, 해·달 갱신
function slowTick() {
  if (observer && sensorMode !== 'sim' && !params.get('sim')) {
    const f = gps.position();
    if (f && Date.now() - lastFix < 10000) book.tick(f.lat, f.lon, f.accuracy, peaks, gpsAltAcc < 20 ? gpsMsl : NaN);
  }
  updateSky(false);
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
function project(q, f, az, el) { return projectDir(qconj(q), f, dirFromAzEl(az, el)); }
/** 세계 방향 벡터 → 화면 좌표. qi = 카메라 자세의 켤레(세계→카메라), 수천 개 꼭짓점도 가볍게. */
function projectDir(qi, f, v) {
  const [w, x, y, z] = qi, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  const cx = v[0] + w * tx + y * tz - z * ty, cy = v[1] + w * ty + z * tx - x * tz, cz = v[2] + w * tz + x * ty - y * tx;
  if (cz >= -0.02) return null;
  return [W / 2 + f * cx / -cz, H / 2 - f * cy / -cz];
}

const COL = { peak: '#73d973', sun: '#ffd04d', moon: '#dfe6ff', gold: '#e8c987', trail: '#ffd84d', path: '#ffe9a3', river: '#5aa8ff', stream: '#7cc0ff', valley: '#8fd18f',
  planet: '#ffd9a0', star: '#c4d0ff', sat: '#66e6ff', plane: '#ff8c40', viewpoint: '#ff7aa8', tower: '#f2f27f', building: '#f2f27f', temple: '#d99cf2', heritage: '#d99cf2', city: '#a8c7ff', town: '#a8c7ff', village: '#c3d6ff' };
const KIND = {
  viewpoint: ['전망대', 'Viewpoint'], tower: ['타워', 'Tower'], building: ['랜드마크', 'Landmark'], temple: ['절', 'Temple'], heritage: ['성곽·문화재', 'Heritage'],
  city: ['도시', 'City'], town: ['읍', 'Town'], village: ['마을', 'Village'], trail: ['등산로', 'Trail'], path: ['산길', 'Path'], river: ['강', 'River'], stream: ['계곡·개울', 'Stream'], valley: ['계곡', 'Valley'],
};
const kindName = k => T(...(KIND[k] || ['', '']));

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
  if (!shareMode) { const gr = g.createLinearGradient(0, 0, 0, 170); gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, 170); }
  const q = cameraQ(), f = focal(), look = cameraAzEl(q);
  placed.length = 0;
  if (!observer) { if (!shareMode) drawTape(look); return; }
  const onScreen = s => s && s[0] > -40 && s[0] < W + 40 && s[1] > -40 && s[1] < H + 40;
  const inView = az => Math.abs(wrap180(az - look.az)) < 80;

  if (layer.sky) { drawPath(q, f, sunPath, COL.sun); drawPath(q, f, moonPath, COL.moon); }
  if (layer.paths) drawLines(q, f);
  const dark = sun && sun.alt < -4; // 해 진 뒤: 별·별자리
  if (layer.sky && dark) drawStars(q, f);
  if (layer.air) drawAirPaths(q, f);

  // 라벨 후보
  const cands = [];
  const hidden = p => demReady && p.occ !== false && p.occ !== null; // 가림(판정 전 포함)
  const isT = p => target && target.id === p.id;
  if (layer.peaks) for (const p of peaks) {
    if (p.dist == null || (!inView(p.az) && !isT(p))) continue;
    const behind = p.dist > 1200 && hidden(p);
    if (!isT(p) && (p.dist > PEAK_RADIUS || (behind && settings.hideOccluded && !(layer.xray && p.occ === true)))) continue;
    const s = project(q, f, p.az, p.el); if (!onScreen(s)) continue;
    const famous = book.isFamous(p.id);
    cands.push({ kind: 'peak', p, s, behind: behind && p.occ === true, famous, summit: book.isSummited(p.id),
      score: 55 + Math.min(15, (p.ele || 0) / 120) - Math.log10(p.dist + 10) * 6 + (famous ? 10 : 0) + (isT(p) ? 1000 : 0) - (behind ? 12 : 0) });
  }
  if (layer.sights) for (const p of sights) {
    if (p.dist == null || p.dist > (p.kind === 'building' || p.kind === 'tower' ? 8000 : 4000) || (!inView(p.az) && !isT(p))) continue;
    const behind = p.dist > 400 && hidden(p);
    if (behind && !layer.xray && !isT(p)) continue;
    const s = project(q, f, p.az, p.el); if (!onScreen(s)) continue;
    cands.push({ kind: p.kind, p, s, behind, score: 40 + (p.kind === 'viewpoint' ? 6 : 0) - Math.log10(p.dist + 10) * 5 + (isT(p) ? 1000 : 0) - (behind ? 10 : 0) });
  }
  if (layer.sights || layer.xray) for (const p of places) {
    if (p.dist == null || !inView(p.az)) continue;
    const behind = p.dist > 600 && hidden(p);
    if (behind ? !layer.xray : !layer.sights) continue;
    const s = project(q, f, p.az, p.el); if (!onScreen(s)) continue;
    cands.push({ kind: p.kind, p, s, behind, score: (p.kind === 'city' ? 42 : p.kind === 'town' ? 36 : 28) - Math.log10(p.dist + 10) * 4 + (isT(p) ? 1000 : 0) });
  }
  if (layer.paths) for (const l of lineLabels(q, f)) cands.push(l);
  if (layer.sky) {
    if (sun && sun.alt > -1) { const s = project(q, f, sun.az, sun.alt); if (onScreen(s)) cands.push({ kind: 'sun', s, score: 70, title: T('해', 'Sun'), sub: `${T('고도', 'alt')} ${sun.alt.toFixed(0)}°` }); }
    if (moon && moon.alt > -1) { const s = project(q, f, moon.az, moon.alt); if (onScreen(s)) cands.push({ kind: 'moon', s, score: 66, title: T('달', 'Moon'), sub: `${moonPhaseName(moon.lit, moon.waxing, EN)} · ${Math.round(moon.lit * 100)}%` }); }
    if (sunEvent) {
      const s = project(q, f, sunEvent.az, -0.27);
      const hh = hm(sunEvent.time), left = (sunEvent.time - new Date()) / 60000;
      if (onScreen(s)) cands.push({ kind: 'sunev', s, score: 62, title: sunEvent.rise ? T(`해돋이 ${hh}`, `Sunrise ${hh}`) : T(`해넘이 ${hh}`, `Sunset ${hh}`),
        sub: left < 60 ? T(`${Math.round(left)}분 뒤`, `in ${Math.round(left)} min`) : T(`${Math.floor(left / 60)}시간 ${Math.round(left % 60)}분 뒤`, `in ${Math.floor(left / 60)} h ${Math.round(left % 60)} min`) });
    }
  }
  if (layer.sky) {
    for (const p of planetsNow) {
      if (p.alt < -1 || (!dark && p.mag > -3.5)) continue; // 낮에는 금성처럼 아주 밝은 것만
      const s = project(q, f, p.az, p.alt); if (!onScreen(s)) continue;
      cands.push({ kind: 'planet', s, score: 58 - p.mag, title: EN ? p.en : p.ko, sub: `${T('행성', 'Planet')} · ${p.mag.toFixed(1)}${T('등급', ' mag')}`, body: p });
    }
    if (dark) for (const st of starsNow.values()) {
      if (st.alt < 2 || st.mag > 1.6) continue;
      const s = project(q, f, st.az, st.alt); if (!onScreen(s)) continue;
      cands.push({ kind: 'star', s, score: 40 - st.mag * 4, title: EN ? st.en : st.ko, sub: EN ? st.conEn : st.con, body: st });
    }
  }
  if (layer.air) {
    for (const v of satsNow) {
      const s = project(q, f, v.az, v.alt); if (!onScreen(s)) continue;
      const visible = v.sunlit && dark, iss = v.s.norad === 25544 || v.s.norad === '25544';
      cands.push({ kind: 'sat', s, score: 44 + (iss ? 14 : 0) + (visible ? 8 : 0) - (v.s.debris ? 10 : 0), title: clip(EN ? v.s.en : v.s.ko, EN ? 26 : 16),
        sub: `${Math.round(v.rangeKm).toLocaleString()} km · ${visible ? T('맨눈 관측 가능', 'naked-eye visible') : v.sunlit ? T('햇빛 받는 중', 'sunlit') : T('지구 그림자 속', "in Earth's shadow")}`, body: v });
    }
    for (const a of aircraft) {
      const p = planeNow(a); if (p.el < -1 || p.dist > 80000) continue;
      const s = project(q, f, p.az, p.el); if (!onScreen(s)) continue;
      cands.push({ kind: 'plane', s, score: 50 - Math.log10(p.dist + 10) * 4, title: a.cs || a.reg || a.hex,
        sub: `${(p.dist / 1000).toFixed(1)} km · ${Math.round(a.alt * 0.3048).toLocaleString()} m${a.type ? ' · ' + a.type : ''}`, body: a });
    }
  }
  for (const c of cands) if (prevShown.has(keyOf(c))) c.score += 8; // 직전에 보이던 라벨은 조금 더 유지(깜빡임↓)
  cands.sort((a, b) => b.score - a.score);

  const top = shareMode ? 40 : 160, bottom = H - (shareMode ? 150 : (target ? 200 : 130));
  const rects = [], count = {};
  const cap = { peak: 12, trail: 4, path: 3, river: 3, stream: 3, valley: 2, planet: 5, star: 8, sat: 4, plane: 6 };
  const now = new Set();
  g.textBaseline = 'alphabetic';
  for (const c of cands) {
    if (placed.length >= 26) break;
    const kk = c.kind; count[kk] = (count[kk] || 0);
    if (cap[kk] && count[kk] >= cap[kk] && !(c.p && isT(c.p))) continue;
    const { title, sub } = labelText(c);
    g.font = '700 15px system-ui, sans-serif'; const tw = g.measureText(title).width;
    g.font = '12px system-ui, sans-serif'; const sw = g.measureText(sub).width;
    const w = Math.max(tw, sw) + 56, h = 44;
    let r = null;
    for (let k = 0; k < 4 && !r; k++) {
      const y = c.s[1] - 18 - h - k * (h + 6), x = Math.max(6, Math.min(W - w - 6, c.s[0] - w / 2));
      if (y < top || y + h > bottom) continue;
      if (rects.some(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y)) continue;
      r = { x, y, w, h };
    }
    if (!r) continue;
    rects.push(r); count[kk]++; now.add(keyOf(c));
    const focused = Math.hypot(c.s[0] - W / 2, c.s[1] - H / 2) < W * 0.12 || (c.p && isT(c.p));
    const col = c.kind === 'peak' ? (c.summit ? COL.gold : COL.peak) : COL[c.kind] || COL.sun;
    g.globalAlpha = c.behind ? 0.78 : 1;
    // 핀·지시선
    g.strokeStyle = focused ? 'rgba(232,201,135,.85)' : 'rgba(255,255,255,.4)'; g.lineWidth = 1.2;
    if (c.behind) g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(c.s[0], c.s[1] - 5); g.lineTo(c.s[0], r.y + h); g.stroke(); g.setLineDash([]);
    g.fillStyle = focused ? COL.gold : 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(c.s[0], c.s[1], 5, 0, 7); g.fill();
    g.fillStyle = col; g.beginPath(); g.arc(c.s[0], c.s[1], 3, 0, 7); g.fill();
    // 라벨(산 너머는 점선 테두리)
    g.fillStyle = focused ? 'rgba(23,22,18,.86)' : 'rgba(14,16,22,.68)';
    roundRect(r.x, r.y, w, h, 14); g.fill();
    g.strokeStyle = focused ? 'rgba(232,201,135,.85)' : c.behind ? 'rgba(168,199,255,.7)' : 'rgba(255,255,255,.14)'; g.lineWidth = 1;
    if (c.behind) g.setLineDash([4, 3]);
    roundRect(r.x + .5, r.y + .5, w - 1, h - 1, 14); g.stroke(); g.setLineDash([]);
    g.fillStyle = hexA(col, .22); g.beginPath(); g.arc(r.x + 22, r.y + h / 2, 14, 0, 7); g.fill();
    icon(c.kind === 'peak' && c.summit ? 'check' : c.kind, r.x + 22, r.y + h / 2, col);
    g.fillStyle = 'rgba(255,255,255,.96)'; g.font = '700 15px system-ui, sans-serif'; g.fillText(title, r.x + 44, r.y + 20);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '12px system-ui, sans-serif'; g.fillText(sub, r.x + 44, r.y + 36);
    g.globalAlpha = 1;
    placed.push({ ...r, c });
  }
  prevShown = now;
  if (!shareMode) { drawTape(look); drawCrosshair(); drawArrow(q, f); }
}

const keyOf = c => (c.p ? c.p.id : c.line ? c.line.id : c.body ? (c.body.id || c.body.key || c.body.hex || c.body.s?.id) : c.kind);
const hm = d => d.toLocaleTimeString(EN ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const eleText = e => (Number.isFinite(e) ? T(`해발 ${Math.round(e).toLocaleString()} m`, `${Math.round(e).toLocaleString()} m`) : '');

function labelText(c) {
  if (c.title) return { title: c.title, sub: c.sub };
  const p = c.p, beyond = c.behind ? T('산 너머 · ', 'beyond · ') : '';
  if (c.kind === 'peak') return { title: clip(shown(p), EN ? 26 : 14), sub: beyond + [formatDist(p.dist), eleText(p.ele), c.famous ? T('100대 명산', 'Top 100') : ''].filter(Boolean).join(' · ') };
  return { title: clip(shown(p), EN ? 26 : 14), sub: beyond + [kindName(c.kind), formatDist(p.dist), c.kind === 'building' && Number.isFinite(p.height) ? `${Math.round(p.height)} m` : ''].filter(Boolean).join(' · ') };
}

// 산길·물길: 땅 위에 선으로(가까울수록 굵고 진하게). 능선 너머로 가는 부분도 숲에 가린 길처럼 그대로 보여 준다
function drawLines(q, f) {
  const qi = qconj(q);
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const l of lines) {
    if (!l.v || l.near > 3000) continue;
    const col = COL[l.kind] || COL.path, thin = l.kind === 'path' && !l.name;
    let prev = null;
    for (let i = 0; i < l.v.length; i++) {
      const v = l.v[i];
      const s = v.dist < 3000 ? projectDir(qi, f, v.dir) : null;
      if (s && prev && Math.abs(s[0] - prev[0]) < W * 2) {
        const d = (v.dist + l.v[i - 1].dist) / 2;
        const a = Math.max(0.18, Math.min(0.95, 1.05 - d / 2500));
        const w = Math.max(1.4, Math.min(thin ? 4 : 7, (thin ? 4 : 7) - d / 450));
        g.strokeStyle = `rgba(0,0,0,${a * 0.45})`; g.lineWidth = w + 2.5; g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke();
        g.strokeStyle = hexA(col, a); g.lineWidth = w; g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke();
      }
      prev = s;
    }
  }
}

// 이름 있는 선마다 화면 가운데에 가장 가까운 꼭짓점에 라벨 하나
function lineLabels(q, f) {
  const out = [], qi = qconj(q);
  for (const l of lines) {
    if (!l.v || !l.name || l.near > 2500) continue;
    let best = null, bd = Infinity;
    for (const v of l.v) {
      if (v.dist < 25 || v.dist > 2500) continue;
      const s = projectDir(qi, f, v.dir); if (!s || s[0] < 20 || s[0] > W - 20 || s[1] < 150 || s[1] > H - 140) continue;
      const d = Math.hypot(s[0] - W / 2, s[1] - H / 2); if (d < bd) { bd = d; best = { s, v }; }
    }
    const dup = best && out.findIndex(o => o.line.name === l.name);
    if (best && dup >= 0) { if (out[dup].bd <= bd) continue; out.splice(dup, 1); } // 같은 이름(여러 조각) → 화면 가운데에 가까운 하나만
    if (best) out.push({ kind: l.kind, line: l, s: best.s, bd, title: clip(EN ? (l.nameEn || romanize(l.name)) : l.name, EN ? 26 : 14),
      sub: `${kindName(l.kind)} · ${formatDist(best.v.dist)}`, score: (l.kind === 'trail' ? 38 : 30) - Math.log10(best.v.dist + 10) * 4 });
  }
  return out;
}

// 별(점, 밝을수록 크게)과 대표 별자리 선
function drawStars(q, f) {
  const pos = new Map();
  for (const st of starsNow.values()) {
    if (st.alt < 0) continue;
    const s = project(q, f, st.az, st.alt); if (!s) continue;
    pos.set(st.key, s);
    g.fillStyle = `rgba(220,228,255,${Math.max(0.35, Math.min(1, 1 - st.mag / 4))})`;
    g.beginPath(); g.arc(s[0], s[1], Math.max(1.2, 3.2 - st.mag), 0, 7); g.fill();
  }
  g.strokeStyle = 'rgba(160,180,255,.35)'; g.lineWidth = 1.2;
  for (const [ko, en, segs] of FIGURES) {
    let any = null;
    for (const sg of segs.split(' ')) {
      const [a, b] = sg.split('-'), pa = pos.get(a), pb = pos.get(b);
      if (!pa || !pb || Math.abs(pa[0] - pb[0]) > W) continue;
      g.beginPath(); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); g.stroke(); any = any || pa;
    }
    if (any && any[0] > 0 && any[0] < W && any[1] > 170 && any[1] < H - 140) { g.font = '11px system-ui'; g.fillStyle = 'rgba(180,195,255,.75)'; g.fillText(EN ? en : ko, any[0] + 6, any[1] + 14); }
  }
}

// 위성: ±5분 하늘 길(점선, 진행 방향 화살촉) / 비행기: 앞으로 3분 직선 항로(점선)
function drawAirPaths(q, f) {
  g.save(); g.setLineDash([3, 5]); g.lineWidth = 1.6;
  for (const v of satsNow) {
    let prev = null; g.strokeStyle = hexA(COL.sat, 0.55);
    for (const p of v.path) {
      const s = p.alt > -2 ? project(q, f, p.az, p.alt) : null;
      if (s && prev && Math.abs(s[0] - prev[0]) < W) { g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke(); }
      prev = s;
    }
  }
  g.strokeStyle = hexA(COL.plane, 0.6);
  for (const a of aircraft) {
    const p0 = planeNow(a); if (p0.dist > 80000) continue;
    let prev = null;
    for (const dt of [0, 30, 60, 90, 120, 150, 180]) {
      const p = dt ? planeNow(a, dt) : p0, s = p.el > -2 ? project(q, f, p.az, p.el) : null;
      if (s && prev && Math.abs(s[0] - prev[0]) < W) { g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke(); }
      prev = s;
    }
  }
  g.restore();
}

// 해·달의 하루 길(점선)과 2시간마다 시각
function drawPath(q, f, pts, col) {
  if (!pts.length) return;
  g.save(); g.setLineDash([2, 6]); g.lineWidth = 2; g.strokeStyle = hexA(col, 0.55); g.lineCap = 'round';
  let prev = null;
  for (const p of pts) {
    const s = p.alt > -3 ? project(q, f, p.az, p.alt) : null;
    if (s && prev && Math.abs(s[0] - prev[0]) < W) { g.beginPath(); g.moveTo(prev[0], prev[1]); g.lineTo(s[0], s[1]); g.stroke(); }
    prev = s;
    if (s && p.t.getMinutes() === 0 && p.t.getHours() % 2 === 0 && p.alt > -1 && s[0] > 0 && s[0] < W && s[1] > 160 && s[1] < H - 140) {
      g.setLineDash([]); g.fillStyle = hexA(col, 0.9); g.beginPath(); g.arc(s[0], s[1], 2.5, 0, 7); g.fill();
      g.font = '11px system-ui'; g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText(EN ? `${p.t.getHours()}h` : `${p.t.getHours()}시`, s[0] + 5, s[1] - 4); g.setLineDash([2, 6]);
    }
  }
  g.restore();
}

function clip(s, n) { return !s ? '' : s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function roundRect(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function icon(kind, x, y, col) {
  g.save(); g.translate(x, y); g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  switch (kind) {
    case 'peak': g.moveTo(-9, 6); g.lineTo(-2, -6); g.lineTo(2, 0); g.lineTo(4, -3); g.lineTo(9, 6); g.closePath(); g.fill(); break;
    case 'check': g.moveTo(-7, 0); g.lineTo(-2, 5); g.lineTo(7, -5); g.stroke(); break;
    case 'moon': g.arc(0, 0, 7, 0, 7); g.fill(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(4, -2, 6, 0, 7); g.fill(); break;
    case 'planet': g.arc(0, 0, 4.5, 0, 7); g.fill(); g.beginPath(); g.ellipse(0, 0, 10, 3.2, -0.4, 0, 7); g.stroke(); break;
    case 'star': for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.moveTo(0, 0); g.lineTo(Math.cos(a) * 8, Math.sin(a) * 8); } g.stroke(); g.beginPath(); g.arc(0, 0, 2.5, 0, 7); g.fill(); break;
    case 'sat': g.fillRect(-2.5, -2.5, 5, 5); g.fillRect(-10, -1.5, 6, 3); g.fillRect(4, -1.5, 6, 3); break;
    case 'plane': g.moveTo(0, -9); g.lineTo(2, -2); g.lineTo(9, 2); g.lineTo(2, 1); g.lineTo(1.5, 6); g.lineTo(4, 8); g.lineTo(-4, 8); g.lineTo(-1.5, 6); g.lineTo(-2, 1); g.lineTo(-9, 2); g.lineTo(-2, -2); g.closePath(); g.fill(); break;
    case 'viewpoint': g.arc(-4, 1, 4, 0, 7); g.moveTo(8, 1); g.arc(4, 1, 4, 0, 7); g.stroke(); break;
    case 'tower': case 'building': g.moveTo(-3, 8); g.lineTo(-1.5, -8); g.lineTo(1.5, -8); g.lineTo(3, 8); g.closePath(); g.fill(); break;
    case 'temple': case 'heritage': g.moveTo(-9, -2); g.lineTo(0, -8); g.lineTo(9, -2); g.closePath(); g.fill(); g.fillRect(-6, -1, 12, 8); break;
    case 'city': case 'town': case 'village': g.fillRect(-7, -1, 5, 8); g.fillRect(-1, -6, 5, 13); g.fillRect(5, 2, 3, 5); break;
    case 'trail': case 'path': g.moveTo(-7, 7); g.quadraticCurveTo(6, 2, -2, -2); g.quadraticCurveTo(-8, -6, 6, -8); g.stroke(); break;
    case 'river': case 'stream': case 'valley': g.moveTo(-8, -3); g.quadraticCurveTo(-4, -7, 0, -3); g.quadraticCurveTo(4, 1, 8, -3); g.moveTo(-8, 4); g.quadraticCurveTo(-4, 0, 0, 4); g.quadraticCurveTo(4, 8, 8, 4); g.stroke(); break;
    default: g.arc(0, 0, 5, 0, 7); g.fill(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.moveTo(Math.cos(a) * 7.5, Math.sin(a) * 7.5); g.lineTo(Math.cos(a) * 10, Math.sin(a) * 10); } g.stroke();
  }
  g.restore();
}

const safeTop = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0;
function drawTape(look) {
  const y = safeTop() + 12, h = 44, x0 = 12, x1 = W - 12;
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

function drawArrow(q, f) {
  if (!target || target.az == null) return;
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
  if (target.sat) { const v = satsNow.find(x => x.s === target.sat); if (v) { target.az = v.az; target.el = v.alt; } }
  else if (target.sky) { const b = target.sky === 'planet' ? planetsNow.find(p => p.id === target.key) : starsNow.get(target.key); if (b) { target.az = b.az; target.el = b.alt; } }
  const look = cameraAzEl(cameraQ()), d = wrap180(target.az - look.az);
  const turn = Math.abs(d) > 150 ? T('뒤로 돌아보세요', 'Turn around') : Math.abs(d) < 12 ? T('화면 가운데쯤', 'Straight ahead') : d > 0 ? T(`오른쪽으로 ${d.toFixed(0)}°`, `${d.toFixed(0)}° right`) : T(`왼쪽으로 ${(-d).toFixed(0)}°`, `${(-d).toFixed(0)}° left`);
  el.querySelector('.gt').textContent = target.title;
  el.querySelector('.gs').textContent = `${target.dist != null ? formatDist(target.dist) + ' · ' : ''}${turn}`;
  if (target.dist != null && target.dist < Math.max(25, observer?.acc || 0) && target.id !== 'sun') { toast(T(`'${target.title}'에 도착했어요`, `You've arrived at '${target.title}'`)); target = null; }
}
$('#guide .x').onclick = () => { target = null; };
$('#guide').onclick = e => { if (e.target.classList.contains('x') || !target) return; const p = [...peaks, ...sights, ...places].find(x => x.id === target.id); if (p) openItem(p); };

let statusText = '';
function updateStatus() {
  let s = '';
  if (locIssue) s = locIssue;
  else if (!observer) s = T('위치를 찾는 중…', 'Finding your location…');
  else if (sensorMode === 'none') s = T('방향 센서를 기다리는 중… (PC는 화면을 끌어 둘러보기)', 'Waiting for motion sensors… (drag to look around on PC)');
  else if (sensorMode === 'imu' && filter.trust < 0.35) s = T('주변 자기장 간섭 — 자이로로 유지 중, 8자로 흔들어 주세요', 'Magnetic interference — holding with gyro; wave in a figure 8');
  else if (observer.acc > 50 && !params.get('sim')) s = T(`GPS 정확도 낮음(±${Math.round(observer.acc)} m)`, `Low GPS accuracy (±${Math.round(observer.acc)} m)`);
  else if (!peaks.length) s = T('주변 자료를 불러오는 중…', 'Loading what is around you…');
  if (s !== statusText) { statusText = s; const el = $('#status'); el.hidden = !s; el.textContent = s; }
}

// ───────── 레이어 칩 ─────────
function buildChips() {
  const box = $('#chips'); box.innerHTML = '';
  const names = { peaks: T('산', 'Peaks'), paths: T('길·물', 'Trails & water'), sights: T('명소', 'Sights'), sky: T('하늘', 'Sky'), air: T('비행기·위성', 'Planes & satellites'), xray: T('산 너머', 'Beyond ridges') };
  for (const k of LAYERS) {
    const b = document.createElement('button'); b.className = 'chip2' + (layer[k] ? ' on' : ''); b.textContent = names[k];
    b.onclick = () => { layer[k] = !layer[k]; store.set('layers', layer); buildChips(); toast(`${names[k]} ${layer[k] ? T('켬', 'on') : T('끔', 'off')}`, 1.2); };
    box.appendChild(b);
  }
  const lg = document.createElement('button'); lg.className = 'chip2'; lg.textContent = EN ? '한국어' : 'EN'; lg.onclick = () => setLang(!EN); box.appendChild(lg);
}

// ───────── 누르기·정보 시트 ─────────
function onTap(x, y) {
  if (!$('#sheet').hidden || !$('#panel').hidden) return;
  for (let i = placed.length - 1; i >= 0; i--) {
    const r = placed[i];
    if (x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 6 && y <= r.y + r.h + 6) {
      const c = r.c;
      if (c.kind === 'peak') { if (!c.behind) book.markSeen(c.p); openItem(c.p, c); }
      else if (c.p) openItem(c.p, c);
      else if (c.line) openLine(c.line);
      else if (c.kind === 'sunev' || c.kind === 'sun') openSun();
      else if (c.kind === 'moon') openMoon();
      else if (c.body) openBody(c);
      return;
    }
  }
}

function sheet(html) { const s = $('#sheet'); s.innerHTML = html + `<button class="x" aria-label="닫기">×</button>`; s.hidden = false; s.querySelector('.x').onclick = closeSheet; return s; }
function closeSheet() { $('#sheet').hidden = true; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = iso => new Date(iso).toLocaleDateString(EN ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });

function guideTo(p, title) {
  target = { id: p.id, title, lat: p.lat, lon: p.lon, ele: p.ele, extra: p.kind === 'peak' ? 0 : 4, az: p.az, el: p.el, dist: p.dist };
  closeSheet(); toast(T(`'${title}' 쪽으로 화살표를 따라가 보세요`, `Follow the arrow to '${title}'`));
}

/** 봉우리·명소·마을 정보: 거리·방향·높이, 도감, 실제 사진, 지도 앱, 따라가기·방향 맞춤. */
function openItem(p, c) {
  const isPeak = p.kind === 'peak';
  const fam = isPeak ? book.famousFor(p) : null, e = isPeak ? (book.entries.get(p.id) || (fam ? book.entryFor(fam) : null)) : null;
  const info = [];
  if (isPeak) {
    const state = e?.summit ? T(`정상 인증 ${fmtDate(e.summit)}`, `Summited ${fmtDate(e.summit)}`) + (e.times > 1 ? T(` · ${e.times}번 오름`, ` · ${e.times} times`) : '')
      : e ? T('담았어요 — 정상 70 m 안에 서면 자동으로 정상 인증', 'Collected — stand within 70 m of the top to verify')
        : fam ? T('아직 못 본 명산 — 화면에 뜬 라벨을 누르면 담겨요', 'Not seen yet — tap its label in view to collect') : '';
    if (state) info.push([T('도감', 'Collection'), state]);
    if (fam && famousName(fam) !== shown(p)) info.push([T('명산', 'Mountain'), famousName(fam)]);
  }
  if (p.occ === true || c?.behind) info.push([T('보임', 'View'), T('앞산에 가려 지금 자리에선 안 보여요', 'Hidden behind a nearer ridge from here')]);
  if (EN && hasKo(p.name)) info.push(['Korean', p.name]);
  const kindLine = isPeak ? T('산봉우리', 'Peak') + (fam ? ' · ' + listNames(book, fam, EN) : '') : kindName(p.kind);
  const height = isPeak ? (Number.isFinite(p.ele) ? Math.round(p.ele).toLocaleString() + ' m' : '–') : Number.isFinite(p.height) ? `${Math.round(p.height)} m` : `${(p.el ?? 0).toFixed(1)}°`;
  const s = sheet(`<h3>${esc(shown(p))}</h3><div class="sub">${esc(kindLine)}</div>
    <div class="stats"><div class="stat"><small>${T('거리', 'Distance')}</small><b>${formatDist(p.dist)}</b></div>
    <div class="stat"><small>${T('방향', 'Direction')}</small><b>${bearingName(p.az, EN)} ${Math.round(p.az)}°</b></div>
    <div class="stat"><small>${isPeak ? T('해발', 'Elevation') : Number.isFinite(p.height) ? T('높이', 'Height') : T('올려볼 각', 'Look up')}</small><b>${height}</b></div></div>
    <div class="info">${info.map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('')}</div>
    <div class="wiki" hidden></div>
    <div class="photos"><div class="note">${T('실제 사진 찾는 중…', 'Looking for real photos…')}</div></div>
    <div class="btns"><button class="p" data-a="guide">${T('따라가기', 'Guide me')}</button><button data-a="align">${T('방향 맞춤', 'Align')}</button>
    <button data-a="maps">${T('지도 앱 · 길찾기', 'Map apps')}</button></div>`);
  s.querySelector('[data-a=guide]').onclick = () => guideTo(p, shown(p));
  s.querySelector('[data-a=align]').onclick = () => {
    if (sensorMode === 'sim') simLook.az = p.az; else filter.alignTo(p.az);
    closeSheet(); toast(T(`'${shown(p)}' 기준으로 방향을 맞췄어요 — 그 산을 화면 가운데에 두고 누르세요`, `Aligned to '${shown(p)}' — center it first`), 3);
  };
  s.querySelector('[data-a=maps]').onclick = () => chooseMap(shown(p), p.lat, p.lon, isPeak || p.dist < 5000);
  fillPhotos(s.querySelector('.photos'), p.lat, p.lon, shown(p));
  if (p.wiki) fillWiki(s.querySelector('.wiki'), p.wiki);
}
const hasKo = s => /[가-힣]/.test(s || '');

function openLine(l) {
  const v = l.v.reduce((a, b) => (b.dist < a.dist ? b : a));
  const i = l.v.indexOf(v), [la, lo] = l.pts[i];
  const len = l.pts.reduce((s, p, k) => (k ? s + haversine(l.pts[k - 1][0], l.pts[k - 1][1], p[0], p[1]) : 0), 0);
  const name = l.name ? (EN ? l.nameEn || romanize(l.name) : l.name) : kindName(l.kind);
  const s = sheet(`<h3>${esc(name)}</h3><div class="sub">${kindName(l.kind)} · ${T('지금 보이는 구간', 'section in view')} ${formatDist(len)}</div>
    <div class="stats"><div class="stat"><small>${T('가장 가까운 곳', 'Nearest point')}</small><b>${formatDist(v.dist)}</b></div>
    <div class="stat"><small>${T('방향', 'Direction')}</small><b>${bearingName(v.az, EN)} ${Math.round(v.az)}°</b></div>
    <div class="stat"><small>${T('높이 차', 'Height diff')}</small><b>${Math.round(Math.tan(v.el * D2R) * Math.max(v.dist, 1))} m</b></div></div>
    <div class="note">${l.kind === 'trail' || l.kind === 'path' ? T('숲에 가려도 길은 그대로 보여 줘요. 실제 길 상태(통제·공사)는 현장 안내를 따르세요.', 'Trails show through the trees. Follow on-site notices for closures.') : T('물길은 비가 오면 불어날 수 있어요. 계곡 안 야영·출입 통제 구역을 확인하세요.', 'Streams can rise fast after rain. Check closures before entering.')}</div>
    <div class="btns"><button class="p" data-a="guide">${T('가까운 곳으로 안내', 'Guide to nearest point')}</button><button data-a="maps">${T('지도 앱', 'Map apps')}</button></div>`);
  s.querySelector('[data-a=guide]').onclick = () => guideTo({ id: l.id, kind: 'line', lat: la, lon: lo, ele: NaN, az: v.az, el: v.el, dist: v.dist }, name);
  s.querySelector('[data-a=maps]').onclick = () => chooseMap(name, la, lo, true);
}

function openSun() {
  const ev = sunEvent, o = observer; if (!o) return;
  const rs = riseSet(sunPath);
  const s = sheet(`<h3>${T('해', 'Sun')}</h3><div class="sub">${sun ? `${T('지금 고도', 'Now at')} ${sun.alt.toFixed(1)}° · ${bearingName(sun.az, EN)} ${Math.round(sun.az)}°` : ''}</div>
    <div class="info">${rs.map(([k, t, az]) => `<div><span>${k}</span>${hm(t)} · ${bearingName(az, EN)} ${Math.round(az)}°</div>`).join('')}
    ${ev ? `<div><span>${T('다음', 'Next')}</span>${ev.rise ? T('해돋이', 'Sunrise') : T('해넘이', 'Sunset')} ${hm(ev.time)} (${T('지평선 기준, 산에 가리면 조금 늦어요', 'on the horizon; later behind hills')})</div>` : ''}
    <div class="note">${T('점선은 오늘 해가 지나가는 길이에요(2시간마다 시각).', 'The dotted arc is today\'s sun path (time every 2 h).')}</div></div>
    <div class="btns">${ev ? `<button class="p" data-a="guide">${ev.rise ? T('해돋이 쪽 안내', 'Guide to sunrise') : T('해넘이 쪽 안내', 'Guide to sunset')}</button>` : ''}</div>`);
  s.querySelector('[data-a=guide]')?.addEventListener('click', () => { target = { id: 'sun', az: ev.az, el: -0.27, title: ev.rise ? T('해돋이', 'Sunrise') : T('해넘이', 'Sunset') }; closeSheet(); });
}
function openMoon() {
  if (!moon) return;
  const rs = riseSet(moonPath);
  sheet(`<h3>${T('달', 'Moon')} · ${moonPhaseName(moon.lit, moon.waxing, EN)}</h3><div class="sub">${T('밝은 면', 'Illuminated')} ${Math.round(moon.lit * 100)}% · ${T('거리', 'distance')} ${Math.round(moon.distKm).toLocaleString()} km</div>
    <div class="info"><div><span>${T('지금', 'Now')}</span>${T('고도', 'alt')} ${moon.alt.toFixed(1)}° · ${bearingName(moon.az, EN)} ${Math.round(moon.az)}°</div>
    ${rs.map(([k, t, az]) => `<div><span>${k}</span>${hm(t)} · ${bearingName(az, EN)} ${Math.round(az)}°</div>`).join('')}</div>
    <div class="note">${T('점선은 지금 앞뒤 12시간 달이 지나가는 길이에요.', 'The dotted arc is the moon path for ±12 hours.')}</div>`);
}
/** 행성·별·위성·비행기 정보. 비행기는 노선(출발→도착)을 받아 보여 준다. */
async function openBody(c) {
  const b = c.body;
  if (c.kind === 'plane') {
    const p = planeNow(b);
    const s = sheet(`<h3>${esc(b.cs || b.reg || b.hex)}</h3><div class="sub">${T('항공기', 'Aircraft')}${b.type ? ' · ' + esc(b.type) : ''}${b.reg ? ' · ' + esc(b.reg) : ''}</div>
      <div class="stats"><div class="stat"><small>${T('고도', 'Altitude')}</small><b>${Math.round(b.alt * 0.3048).toLocaleString()} m</b></div>
      <div class="stat"><small>${T('속도', 'Speed')}</small><b>${Math.round((b.gs || 0) * 1.852)} km/h</b></div>
      <div class="stat"><small>${T('거리', 'Distance')}</small><b>${(p.dist / 1000).toFixed(1)} km</b></div></div>
      <div class="info"><div><span>${T('노선', 'Route')}</span><b class="route">${T('찾는 중…', 'Looking up…')}</b></div><div><span>${T('진행 방향', 'Heading')}</span>${bearingName(b.trk || 0, EN)} ${Math.round(b.trk || 0)}°</div></div>
      <div class="note">${T('점선은 앞으로 3분 동안 지금 방향·속도로 갈 길이에요. 자료: adsb.lol(ODbL)', 'Dotted line: next 3 minutes at current heading and speed. Data: adsb.lol (ODbL)')}</div>
      <div class="btns"><button class="p" data-a="fr">${T('자세히(Flightradar24)', 'More (Flightradar24)')}</button></div>`);
    s.querySelector('[data-a=fr]').onclick = () => open(`https://www.flightradar24.com/${encodeURIComponent(b.cs || b.reg || '')}`, '_blank');
    let txt = T('노선 정보 없음', 'No route info');
    if (b.cs) try {
      const j = await (await fetch(`${AIR_URL}?route=${encodeURIComponent(b.cs)}`, { headers: { Authorization: 'Bearer ' + ANON, apikey: ANON } })).json();
      const r = j.route; if (r?.from && r?.to) txt = `${r.from.city || r.from.name} (${r.from.iata}) → ${r.to.city || r.to.name} (${r.to.iata})${r.airline ? ' · ' + r.airline : ''}`;
    } catch { }
    const el = s.querySelector('.route'); if (el && el.isConnected) el.textContent = txt;
    return;
  }
  if (c.kind === 'sat') {
    const v = b, dark = sun && sun.alt < -4;
    const s = sheet(`<h3>${esc(EN ? v.s.en : v.s.ko)}</h3><div class="sub">${T('인공위성', 'Satellite')} · NORAD ${v.s.norad}</div>
      <div class="stats"><div class="stat"><small>${T('높이', 'Height')}</small><b>${Math.round(v.heightKm).toLocaleString()} km</b></div>
      <div class="stat"><small>${T('거리', 'Distance')}</small><b>${Math.round(v.rangeKm).toLocaleString()} km</b></div>
      <div class="stat"><small>${T('고도각', 'Elevation')}</small><b>${v.alt.toFixed(0)}°</b></div></div>
      <div class="note">${v.sunlit ? (dark ? T('햇빛을 반사해 지금 맨눈으로 보일 수 있어요(별처럼 움직이는 점).', 'Reflecting sunlight — you may see it now as a moving star.') : T('햇빛을 받고 있지만 하늘이 밝아 안 보여요.', 'Sunlit, but the sky is too bright to see it.')) : T('지구 그림자 속이라 안 보여요.', "In Earth's shadow — not visible.")}
      ${T('점선은 앞뒤 5분 동안 지나가는 길이에요.', 'The dotted arc is its path ±5 minutes.')}</div>
      <div class="btns"><button class="p" data-a="guide">${T('따라가기', 'Guide me')}</button><button data-a="n2yo">${T('자세히', 'More')}</button></div>`);
    s.querySelector('[data-a=guide]').onclick = () => { target = { id: v.s.id, title: EN ? v.s.en : v.s.ko, az: v.az, el: v.alt, sat: v.s }; closeSheet(); };
    s.querySelector('[data-a=n2yo]').onclick = () => open(`https://www.n2yo.com/satellite/?s=${v.s.norad}`, '_blank');
    return;
  }
  const isPlanet = c.kind === 'planet';
  const s = sheet(`<h3>${esc(c.title)}</h3><div class="sub">${isPlanet ? T('행성', 'Planet') : `${T('별', 'Star')} · ${esc(EN ? b.conEn : b.con)}`}</div>
    <div class="stats"><div class="stat"><small>${T('밝기', 'Magnitude')}</small><b>${b.mag.toFixed(1)}</b></div>
    <div class="stat"><small>${T('방향', 'Direction')}</small><b>${bearingName(b.az, EN)} ${Math.round(b.az)}°</b></div>
    <div class="stat"><small>${T('고도각', 'Elevation')}</small><b>${b.alt.toFixed(0)}°</b></div></div>
    ${isPlanet ? `<div class="note">${T('지구에서', 'From Earth')} ${(b.distAu * 149.6).toFixed(0)}${T('백만 km', ' million km')}</div>` : ''}
    <div class="btns"><button class="p" data-a="guide">${T('따라가기', 'Guide me')}</button></div>`);
  s.querySelector('[data-a=guide]').onclick = () => { target = { id: isPlanet ? b.id : b.key, title: c.title, az: b.az, el: b.alt, sky: c.kind, key: isPlanet ? b.id : b.key }; closeSheet(); };
}

/** 경로에서 뜨고 지는 시각(10분 간격 → 선형 보간). */
function riseSet(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.alt < 0) !== (b.alt < 0)) {
      const k = a.alt / (a.alt - b.alt), t = new Date(a.t.getTime() + (b.t - a.t) * k);
      out.push([a.alt < 0 ? T('뜸', 'Rise') : T('짐', 'Set'), t, a.az + wrap180(b.az - a.az) * k]);
    }
  }
  return out;
}

// 실제 사진(위키미디어 공용) — 눌러서 크게 보거나 지금 화면에 반투명으로 겹쳐 비교
async function fillPhotos(box, lat, lon, name) {
  const ph = await photosNear(lat, lon, 1500, 10);
  if (!box.isConnected) return;
  if (!ph.length) { box.innerHTML = `<div class="note">${T('근처에서 찍은 공개 사진이 아직 없어요.', 'No public photos taken nearby yet.')}</div>`; return; }
  box.innerHTML = `<div class="note">${T('근처에서 찍은 실제 사진 — 누르면 지금 화면에 겹쳐 비교', 'Real photos taken nearby — tap to overlay and compare')}</div><div class="strip"></div>`;
  const strip = box.querySelector('.strip');
  for (const p of ph) {
    const im = document.createElement('img'); im.src = p.thumb; im.loading = 'lazy'; im.alt = p.title; im.title = p.title;
    im.onclick = () => compare(p, name);
    strip.appendChild(im);
  }
}
async function fillWiki(box, wiki) {
  const i = wiki.indexOf(':'); if (i < 0) return;
  try {
    const j = await (await fetch(`https://${wiki.slice(0, i)}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wiki.slice(i + 1))}`)).json();
    if (!j.extract || !box.isConnected) return;
    box.hidden = false;
    box.innerHTML = `<div class="note">${esc(j.extract.slice(0, 220))}${j.extract.length > 220 ? '…' : ''} <a href="${esc(j.content_urls?.mobile?.page || '#')}" target="_blank" rel="noopener">${T('위키백과', 'Wikipedia')}</a></div>`;
  } catch { }
}
function compare(p, name) {
  closeSheet();
  const c = $('#compare'); c.hidden = false;
  $('#cmpImg').src = p.full; $('#cmpImg').hidden = false;
  c.querySelector('.cap').innerHTML = `${esc(p.title)}${p.author ? ' · ' + esc(p.author) : ''} · <a href="${esc(p.page)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
  const r = c.querySelector('input'); r.value = 55; $('#cmpImg').style.opacity = 0.55;
  r.oninput = () => { $('#cmpImg').style.opacity = r.value / 100; };
  toast(T(`'${name}' 근처 사진을 겹쳤어요 — 휴대폰을 같은 방향으로 맞춰 보세요`, `Overlaid a photo near '${name}' — line your view up with it`), 3.5);
}
$('#compare .x').onclick = () => { $('#compare').hidden = true; $('#cmpImg').hidden = true; };

function chooseMap(name, lat, lon, walk) {
  const apps = mapApps(name, lat, lon, walk, EN);
  const s = sheet(`<h3>${T('지도 앱으로 열기', 'Open in a map app')}</h3><div class="sub">${esc(name)} · ${walk ? T('걷기 길찾기', 'walking directions') : T('길찾기', 'directions')}</div>
    <div class="btns">${apps.map((a, i) => `<button ${i === 0 ? 'class="p"' : ''} data-i="${i}">${esc(a.name)}</button>`).join('')}</div>
    <div class="note">${T('설치된 앱이 없으면 웹 지도로 열려요.', 'Opens the web map if the app is not installed.')}</div>`);
  s.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => openApp(apps[+b.dataset.i]); });
}

// ───────── 지도 앱에서 공유받은 장소 → 그쪽으로 화살표 ─────────
async function handleShared() {
  const raw = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n');
  if (!raw) return;
  history.replaceState(null, '', location.pathname);
  let m = raw.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || raw.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || raw.match(/geo:(-?\d+\.\d+),(-?\d+\.\d+)/)
    || raw.match(/[?&](?:q|query|ll|destination|daddr|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i) || raw.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{2,3}\.\d{3,})/);
  // 짧은 링크만 있으면(카카오·네이버·구글 공유) 장소 이름으로 찾기: 내 주변 봉우리·명소 → 오픈스트리트맵 검색
  const name = (params.get('title') || raw.split('\n')[0] || '').replace(/\[[^\]]*\]/g, '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 60);
  if (!m && name) {
    for (let k = 0; k < 20 && !observer; k++) await new Promise(r => setTimeout(r, 500));
    const local = [...peaks, ...sights].find(p => p.name === name || p.nameEn === name);
    if (local) m = [0, local.lat, local.lon];
    else try {
      const near = observer ? `&viewbox=${observer.lon - 1},${observer.lat + 1},${observer.lon + 1},${observer.lat - 1}` : '';
      const j = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=${EN ? 'en' : 'ko'}${near}&q=${encodeURIComponent(name)}`)).json();
      if (j[0]) m = [0, j[0].lat, j[0].lon];
    } catch { }
  }
  if (!m) { toast(T('공유받은 내용에서 위치를 찾지 못했어요', "Couldn't find a location in what was shared"), 4); return; }
  const lat = +m[1], lon = +m[2];
  for (let k = 0; k < 20 && !observer; k++) await new Promise(r => setTimeout(r, 500));
  target = { id: 'shared', title: name || T('공유받은 장소', 'Shared place'), lat, lon, ele: NaN, extra: 2 };
  if (observer) locate(target, observer, 2);
  toast(T(`'${target.title}' 쪽으로 화살표를 따라가 보세요`, `Follow the arrow to '${target.title}'`), 4);
}

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
    if (!p) { p = { id, kind: 'peak', name, ele, lat, lon }; if (o) locate(p, o); }
    if (p.dist != null) openItem(p);
  };
  if (l) {
    const p = book.progress(key);
    note(b, T(`정상 인증 ${p.summit} · 본 봉우리 ${p.seen} · 전체 ${p.total}. 정상 70 m 안에 서면 자동으로 인증돼요.`, `${p.summit} summited · ${p.seen} seen · ${p.total} total. Stand within 70 m of a top to verify.`));
    const rows = book.famous.filter(f => f.lists.includes(key)).map(f => ({ f, e: book.entryFor(f), d: o ? haversine(o.lat, o.lon, f.lat, f.lon) : 0 }));
    const rank = e => (!e ? 2 : e.summit ? 0 : 1);
    rows.sort((a, c) => rank(a.e) - rank(c.e) || (a.e ? ((c.e.last || c.e.seen) > (a.e.last || a.e.seen) ? 1 : -1) : o ? a.d - c.d : a.f.name.localeCompare(c.f.name)));
    for (const r of rows) row(b, `${famousName(r.f)}   ${Math.round(r.f.ele).toLocaleString()} m`, r.e ? detailOf(r.e) : o ? `${formatDist(r.d)} · ${bearingName(bearing(o.lat, o.lon, r.f.lat, r.f.lon), EN)}` : '',
      r.e?.summit ? 'on' : r.e ? 'seen' : '', r.e?.summit ? 'check' : 'peak', () => openAt(r.f.id, famousKo(r.f), r.f.ele, r.f.lat, r.f.lon));
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
  row(b, '언어 · Language', EN ? 'English → 한국어' : '한국어 → English', '', 'peak', () => setLang(!EN));
  sec(b, T('방향·화면', 'Direction & view'));
  row(b, T('나침반 다시 맞추기', 'Reset compass alignment'), T('[방향 맞춤]으로 바꾼 보정을 지우고 나침반을 다시 따라가요', 'Clears manual alignment and follows the compass again'), '', 'peak', () => { filter.resetAlignment(); toast(T('폰을 들고 8자를 그려 주세요', 'Wave your phone in a figure 8')); $('#panel').hidden = true; });
  row(b, T('앞산에 가린 봉우리 숨기기', 'Hide peaks behind hills'), settings.hideOccluded ? T('켜짐 — 실제로 보이는 봉우리만(산 너머 칩을 켜면 점선으로)', 'On — visible peaks only (Beyond ridges shows them dashed)') : T('꺼짐 — 가려진 봉우리도', 'Off — hidden peaks too'), '', 'peak', () => { settings.hideOccluded = !settings.hideOccluded; store.set('hideOccluded', settings.hideOccluded); showMenu(); });
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
      `${T('지형', 'Terrain')}: ${terrain.loadedTiles()} ${T('타일', 'tiles')} · ${T('봉우리', 'peaks')} ${peaks.length} · ${T('길·물', 'lines')} ${lines.length} · ${T('명소', 'sights')} ${sights.length} · ${T('마을', 'places')} ${places.length}`,
    ].join('<br>');
    setTimeout(tick, 500);
  };
  tick();
  sec(b, T('정보', 'About'));
  note(b, '© OpenStreetMap contributors (ODbL) · AWS Terrain Tiles · Wikimedia Commons · 산림청·블랙야크 100대 명산 목록');
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
  if (!place) { const pk = placed.find(r => r.c.kind === 'peak' && Math.abs(r.x + r.w / 2 - W / 2) < W * .2) || placed.find(r => r.c.kind === 'peak'); place = pk ? shown(pk.c.p) + (Number.isFinite(pk.c.p.ele) ? ' · ' + eleText(pk.c.p.ele) : '') : T('지금 보는 풍경', "What I'm looking at"); }
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

// ───────── 정상 인증 ─────────
book.onSummit = (h, e) => {
  const name = h.famous ? famousName(h.famous) : (EN ? romanize(h.name) : h.name);
  const lines2 = h.famous ? book.lists.filter(l => h.famous.lists.includes(l.key)).map(l => { const p = book.progress(l.key); return `${EN ? l.titleEn : l.title}   ${p.summit} / ${p.total}`; }) : [];
  lines2.push(T(`내가 오른 봉우리 ${book.summitCount}곳`, `Summits so far: ${book.summitCount}`));
  const s = sheet(`<h3>${e.times > 1 ? T(`${esc(name)} — ${e.times}번째 정상`, `${esc(name)} — summit #${e.times}`) : T(`${esc(name)} 정상 인증`, `Summit: ${esc(name)}`)}</h3>
    <div class="sub">${h.ele ? eleText(h.ele) + ' · ' : ''}${new Date().toLocaleString(EN ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}</div>
    <div class="info">${lines2.map(l => `<div>${esc(l)}</div>`).join('')}</div>
    <div class="btns"><button class="p" data-a="shot">${T('정상 사진 남기기', 'Summit photo')}</button><button data-a="book">${T('도감 보기', 'Collection')}</button></div>`);
  s.querySelector('[data-a=shot]').onclick = () => { closeSheet(); shareShot(T(`${name} 정상`, `${name} summit`) + (h.ele ? ` · ${Math.round(h.ele).toLocaleString()} m` : '')); };
  s.querySelector('[data-a=book]').onclick = () => { closeSheet(); showCollection(h.famous ? h.famous.lists[0] : null); };
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
};

// ───────── 알림·설치 ─────────
let toastTimer = 0;
function toast(msg, sec = 2.5) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, sec * 1000); }

let deferredInstall = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (!isStandalone()) { $('#install').hidden = false; $('#install2').hidden = false; $('#andHint').hidden = true; } });
addEventListener('appinstalled', () => { deferredInstall = null; $('#install').hidden = true; $('#install2').hidden = true; toast(T('설치했어요 — 홈 화면의 지오렌즈로 바로 열 수 있어요', 'Installed — open GeoLens from your home screen')); });
async function installApp() { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => { }); deferredInstall = null; $('#install').hidden = true; $('#install2').hidden = true; }
$('#install').onclick = installApp; $('#install2').onclick = installApp;
$('#install').textContent = T('앱 설치', 'Install app');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

// ───────── 첫 화면 또는 바로 시작(모든 변수가 준비된 뒤) ─────────
const needsTap = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'; // iOS: 센서 권한은 누름 안에서만
if (params.get('sim') || (store.get('started', false) && !needsTap)) start(); else {
  $('#welcome').hidden = false;
  if (isIOS && !isStandalone()) $('#iosHint').hidden = false;
  else if (!isStandalone()) setTimeout(() => { if (!deferredInstall) $('#andHint').hidden = false; }, 2500);
}

// 시험용(자동 테스트·디버그)
window.geolens = { filter, gps, book, layer, get peaks() { return peaks; }, get lines() { return lines; }, get sights() { return sights; }, get places() { return places; },
  get observer() { return observer; }, get placed() { return placed; }, get moon() { return moon; }, openItem, openLine, showBook, showCollection, showMenu, chooseMap,
  setLook: (az, el) => { sensorMode = 'sim'; simLook = { az, el }; } };
