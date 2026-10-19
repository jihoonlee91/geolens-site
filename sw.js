// 오프라인 지원: 앱 화면은 미리 저장(새 버전은 다음 실행 때), 지도·지형 자료는 한 번 받은 것을 산에서도(신호 없을 때) 그대로 사용.
const VERSION = 'v3';
const SHELL = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/fusion.js', 'js/gps.js', 'js/geo.js', 'js/terrain.js', 'js/book.js', 'js/hangul.js', 'js/sky.js', 'js/layers.js', 'js/links.js', 'js/space.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open('shell-' + VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== 'shell-' + VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 지형 타일·봉우리 타일(주소에 버전이 붙음): 캐시 우선
  if (url.hostname === 's3.amazonaws.com' || /\/data\/(nature|sights|food|trails)\//.test(url.pathname)) {
    e.respondWith(caches.open('data').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // 그 밖(앱 화면·meta·명산 목록): 네트워크 우선, 안 되면 캐시
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && !url.pathname.endsWith('.apk')) { const copy = res.clone(); caches.open(url.pathname.includes('/data/') ? 'data' : 'shell-' + VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: false }).then(r => r || caches.match('index.html'))));
  }
});
