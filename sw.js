// TerraUnlock service worker (generado en build)
const VERSION = 'mub1sdap';
const SHELL = 'tu-shell-' + VERSION;
const TILES = 'tu-tiles-v1';
const PRECACHE = ["./assets/browser-DGemqFXA.js","./assets/fit-parser-GrBu7W1E.js","./assets/index-BUePBon2.js","./assets/index-BxWy4VdB.css","./data/peaks-world.json","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./manifest.webmanifest"];
const TILE_HOSTS = ['server.arcgisonline.com', 'ibasemaps-api.arcgis.com', 'services.arcgisonline.com'];
const MAX_TILES = 1500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tu-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Tiles de satelite: cache-first con recorte
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) {
          cache.put(e.request, res.clone());
          cache.keys().then((keys) => { if (keys.length > MAX_TILES) cache.delete(keys[0]); });
        }
        return res;
      })
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navegacion: red primero, offline -> shell cacheado
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }
  // Estaticos: cache-first, rellenando cache
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname.endsWith('.html') }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return res;
    }))
  );
});
