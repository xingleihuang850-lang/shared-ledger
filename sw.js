const CACHE = 'ledger-v6';
// 预缓存核心静态资源，确保离线可用
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // CDN 资源：缓存优先
  if (url.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(e.request).then(r => r || fetch(e.request).then(res => {
          c.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // HTML 页面：网络优先，始终获取最新版本
  if (e.request.mode === 'navigate' || url.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        return caches.open(CACHE).then(c => {
          c.put(e.request, res.clone());
          return res;
        });
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // 其他静态资源：缓存优先
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      return caches.open(CACHE).then(c => {
        c.put(e.request, res.clone());
        return res;
      });
    }))
  );
});

// 监听更新消息
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
