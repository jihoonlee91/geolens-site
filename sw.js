// 공개 사이트 서비스 워커: 로그인 화면(shell)과 로그인 라이브러리는 미리 저장, 지도·지형 자료는 한 번 받은 것을 산에서도 그대로.
// 앱 본체 번들은 shell이 로그인 확인 뒤 따로 저장한다(peaklens-app).
const VERSION = 'v5';
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.min.js';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', LIB];

self.addEventListener('install', e => {
  e.waitUntil(caches.open('shell-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== 'shell-' + VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const cacheFirst = (name, req) => caches.open(name).then(async c => {
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.url === LIB) { e.respondWith(cacheFirst('shell-' + VERSION, req)); return; }
  // 지형 타일·봉우리 타일(주소에 버전이 붙음): 캐시 우선
  if (url.hostname === 's3.amazonaws.com' || (url.origin === location.origin && /\/data\/(nature|sights|food|trails)\//.test(url.pathname))) {
    e.respondWith(cacheFirst('data', req));
    return;
  }
  // 그 밖(로그인 화면·meta·명산 목록): 네트워크 우선, 안 되면 캐시. 로그인 돌아오는 주소(?code=)는 저장하지 않음
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && !url.pathname.endsWith('.apk') && !url.searchParams.has('code')) { const copy = res.clone(); caches.open(url.pathname.includes('/data/') ? 'data' : 'shell-' + VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./'))));
  }
});
