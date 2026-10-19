// 웹 앱은 비공개(상지홈)로 옮겼다. 예전에 설치된 서비스 워커를 지우고 캐시를 비운다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll()).then(cs => cs.forEach(c => c.navigate(c.url))));
});
