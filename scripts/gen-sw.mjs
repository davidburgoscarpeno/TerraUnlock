// Genera dist/sw.js tras el build: precache del app shell + runtime cache de tiles y datos.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist';
const precache = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (!p.endsWith('sw.js')) precache.push('./' + path.relative(dist, p).split(path.sep).join('/'));
  }
})(dist);
const version = Date.now().toString(36);
const sw = `// TerraUnlock service worker (generado en build)
const VERSION = '${version}';
const SHELL = 'tu-shell-' + VERSION;
const TILES = 'tu-tiles-v1';
const PRECACHE = ${JSON.stringify(precache, null, 0)};
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
`;
fs.writeFileSync(path.join(dist, 'sw.js'), sw);
console.log('sw.js generado con', precache.length, 'entradas precache');
