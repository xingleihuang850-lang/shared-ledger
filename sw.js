const CACHE = 'ledger-v9-20260824';
// 预缓存核心静态资源，确保离线可用
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.css?v=1.2.1',
  './app.js',
  './app.js?v=1.2.1',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
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
  if (e.request.method !== 'GET') return;
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
      }).catch(() =>
        caches.match(e.request).then(r => r || caches.match('./index.html') || caches.match('./'))
      )
    );
    return;
  }

  // 本站静态资源：网络优先，离线时回退缓存。
  // 这样即使文件名不变，发布后的 app.js/app.css 也能在下次启动时更新。
  e.respondWith(
    fetch(e.request).then(res => {
      if (!res || !res.ok) return res;
      return caches.open(CACHE).then(c => {
        c.put(e.request, res.clone());
        return res;
      });
    }).catch(() => caches.match(e.request))
  );
});

// 监听更新消息
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
