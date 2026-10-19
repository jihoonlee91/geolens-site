// 봉우리 도감(앱과 같은 규칙): 화면에 뜬 산 라벨을 열면 담기, 정상 70 m 안(GPS ±40 m 이내)으로 2회 연속이면 정상 인증.
// 100대 명산(산림청·블랙야크) 목록과 맞춰 진행률. 이 기기(localStorage)에만 저장, 서버로 위치를 보내지 않는다.
import { haversine } from './geo.js';

const KEY = 'geolens.book.v1';
export const SUMMIT_RADIUS = 70, MAX_ACCURACY = 40, SAME = 120;

export class Book {
  constructor() {
    this.entries = new Map(); this.famous = []; this.famousById = new Map(); this.lists = [];
    this.onChange = () => {}; this.onSummit = () => {};
    try { for (const e of JSON.parse(localStorage.getItem(KEY) || '[]')) this.entries.set(e.id, e); } catch { }
    this.cand = null; this.streak = 0;
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify([...this.entries.values()])); } catch { } this.onChange(); }

  setFamous(doc) {
    this.lists = Object.entries(doc.lists || {}).map(([key, v]) => ({ key, title: v.title, titleEn: v.titleEn, count: v.count }))
      .sort((a, b) => (a.key === 'forest100' ? 0 : a.key === 'bac100' ? 1 : 2) - (b.key === 'forest100' ? 0 : b.key === 'bac100' ? 1 : 2));
    this.famous = (doc.peaks || []).filter(p => p.id && isFinite(p.lat));
    this.famousById = new Map(this.famous.map(p => [p.id, p]));
    this.onChange();
  }

  get seenCount() { return this.entries.size; }
  get summitCount() { let n = 0; for (const e of this.entries.values()) if (e.summit) n++; return n; }
  isSummited(id) { return !!this.entries.get(id)?.summit; }
  isFamous(id) { return this.famousById.has(id); }
  famousNear(lat, lon) { return this.famous.find(f => haversine(lat, lon, f.lat, f.lon) < SAME) || null; }
  famousFor(p) { return this.famousById.get(p.id) || this.famousNear(p.lat, p.lon); }
  entryFor(f) {
    const e = this.entries.get(f.id); if (e) return e;
    let best = null;
    for (const x of this.entries.values()) if (haversine(x.lat, x.lon, f.lat, f.lon) < SAME && (!best || (x.summit && !best.summit))) best = x;
    return best;
  }
  progress(key) {
    let s = 0, n = 0, total = 0;
    for (const f of this.famous) { if (!f.lists.includes(key)) continue; total++; const e = this.entryFor(f); if (e) { n++; if (e.summit) s++; } }
    const li = this.lists.find(l => l.key === key); if (li?.count) total = li.count;
    return { summit: s, seen: n, total };
  }

  /** 라벨을 연 봉우리 담기(새로 담으면 true). */
  markSeen(p) {
    if (this.entries.has(p.id)) return false;
    this.entries.set(p.id, { id: p.id, name: p.name, ele: p.ele || 0, lat: p.lat, lon: p.lon, seen: new Date().toISOString() });
    this.save(); return true;
  }

  /** 이 위치에서 인증할 정상(없으면 null). peaks: 지금 불러온 봉우리. */
  findSummit(lat, lon, accuracy, peaks, gpsMsl = NaN) {
    if (!(accuracy > 0) || accuracy > MAX_ACCURACY) return null;
    let best = null, bd = SUMMIT_RADIUS;
    for (const p of peaks) { const d = haversine(lat, lon, p.lat, p.lon); if (d <= bd) { bd = d; best = { id: p.id, name: p.name, ele: p.ele || 0, lat: p.lat, lon: p.lon }; } }
    for (const f of this.famous) {
      const d = haversine(lat, lon, f.lat, f.lon);
      if (d < bd) { bd = d; best = { id: f.id, name: f.summit === '정상' ? f.name : f.summit, ele: f.ele, lat: f.lat, lon: f.lon }; }
    }
    if (!best) return null;
    if (isFinite(gpsMsl) && best.ele > 0 && gpsMsl < best.ele - 80) return null;
    best.famous = this.famousById.get(best.id) || this.famousNear(best.lat, best.lon);
    return best;
  }

  /** 2초마다 호출: 같은 정상이 두 번 연속(2초에 60 m 넘게 튀지 않고)이면 인증. */
  tick(lat, lon, accuracy, peaks, gpsMsl) {
    const hit = this.findSummit(lat, lon, accuracy, peaks, gpsMsl);
    if (!hit) { this.cand = null; this.streak = 0; return; }
    const jumped = this.cand && haversine(lat, lon, this.cand.lat, this.cand.lon) > 60;
    if (!this.cand || this.cand.id !== hit.id || jumped) { this.cand = { id: hit.id, lat, lon }; this.streak = 0; }
    this.cand.lat = lat; this.cand.lon = lon;
    if (++this.streak >= 2) { this.streak = 0; this.summit(hit); }
  }

  summit(h) {
    const today = new Date().toDateString();
    let e = this.entries.get(h.id);
    if (!e) { e = { id: h.id, name: h.name, ele: h.ele, lat: h.lat, lon: h.lon, seen: new Date().toISOString() }; this.entries.set(h.id, e); }
    if (e.last && new Date(e.last).toDateString() === today) return false;
    if (!e.summit) e.summit = new Date().toISOString();
    e.last = new Date().toISOString(); e.times = (e.times || 0) + 1;
    this.save(); this.onSummit(h, e); return true;
  }

  sorted() {
    return [...this.entries.values()].sort((a, b) => (!!b.summit - !!a.summit) || ((b.last || b.seen) > (a.last || a.seen) ? 1 : -1));
  }

  csv(en) {
    const esc = s => (s == null ? '' : /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const day = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
    const rows = [en ? 'Lists,Mountain,Peak,Elevation (m),Status,Summited,Times,First seen,Latitude,Longitude' : '목록,산,봉우리,해발(m),상태,정상 인증,오른 횟수,처음 본 날,위도,경도'];
    for (const e of this.sorted()) {
      const f = this.famousById.get(e.id) || this.famousNear(e.lat, e.lon);
      rows.push([f ? listNames(this, f, en) : '', f ? f.name : e.name, f ? (f.summit === '정상' ? f.name : f.summit) : '', e.ele ? Math.round(e.ele) : '',
        e.summit ? (en ? 'Summited' : '정상 인증') : (en ? 'Seen' : '본 봉우리'), day(e.summit), e.summit ? e.times || 1 : '', day(e.seen), e.lat.toFixed(5), e.lon.toFixed(5)].map(esc).join(','));
    }
    return '﻿' + rows.join('\r\n') + '\r\n';
  }
}

export function listNames(book, f, en) {
  if (f.lists.includes('forest100') && f.lists.includes('bac100')) return en ? 'Top 100 (Forest Service · Black Yak)' : '100대 명산 (산림청·블랙야크)';
  return book.lists.filter(l => f.lists.includes(l.key)).map(l => (en ? l.titleEn : l.title)).join(' · ');
}
export const famousName = f => (!f.summit || f.summit === '정상' || f.summit === f.name ? f.name : `${f.name} ${f.summit}`);
