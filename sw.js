/* museum service worker — 离线 + 更新 */

const BUILD = '202607300026';
const CACHE = 'museum-' + BUILD;
const NET_TIMEOUT = 3000;

const SHELL = [
  './',
  './index.html',
  './app.css?v=' + BUILD,
  './app.js?v=' + BUILD,
  './marked.min.js?v=' + BUILD,
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './data/meta.json',
  './data/check.json',
  './data/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (u) => {
      try {
        const res = await fetch(new Request(u, { cache: 'reload' }));
        if (res && res.ok) await cache.put(u, res.clone());
      } catch (err) { /* 单项失败不阻断安装 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n !== CACHE && n.indexOf('museum-') === 0) ? caches.delete(n) : null));
    await self.clients.claim();
  })());
});

function isNetFirst(u) {
  const p = u.pathname;
  return p.indexOf('/data/') >= 0 || /index\.html$/.test(p) || /\/$/.test(p) || /manifest\.webmanifest$/.test(p);
}

function rejectAfter(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

function fresh(req) {
  // 导航请求不能重建 Request（mode 受限），其余一律绕过 HTTP 缓存
  if (req.mode === 'navigate') return fetch(req);
  return fetch(new Request(req.url, { cache: 'no-store' }));
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const netP = fresh(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  netP.catch(() => {});
  const hit = await cache.match(req);
  if (!hit) {
    try {
      return await netP;
    } catch (err) {
      if (req.mode === 'navigate') {
        const idx = await cache.match('./index.html');
        if (idx) return idx;
      }
      const any = await caches.match(req, { ignoreSearch: true });
      if (any) return any;
      return new Response('', { status: 504, statusText: 'offline' });
    }
  }
  try {
    const res = await Promise.race([netP, rejectAfter(NET_TIMEOUT)]);
    return (res && res.ok) ? res : hit;
  } catch (err) {
    return hit;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const any = await caches.match(req, { ignoreSearch: true });
    if (any) return any;
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;
  e.respondWith((req.mode === 'navigate' || isNetFirst(u)) ? networkFirst(req) : cacheFirst(req));
});

self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'museum-prefetch' || !Array.isArray(d.urls)) return;
  e.waitUntil(prefetch(d.urls));
});

// 整馆离线：串行预取全部密文
async function prefetch(urls) {
  const cache = await caches.open(CACHE);
  for (const u of urls) {
    try {
      if (new URL(u, self.location.href).origin !== self.location.origin) continue;
      if (await cache.match(u)) continue;
      const res = await fetch(new Request(u, { cache: 'no-store' }));
      if (res && res.ok) await cache.put(u, res.clone());
    } catch (err) { /* 跳过失败项 */ }
  }
}
