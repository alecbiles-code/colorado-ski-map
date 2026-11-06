// Service worker for Skintrack CO. Scope is this directory only (registered as ./sw.js).
// 1. App shell (HTML, JS, CSS, vendor, glyphs, sprite, icons): served from cache, refreshed in the background.
// 2. Small site data (data/**/*.json and *.geojson): network first, falling back to the 'skintrack-data' cache.
// 3. Everything else passes through untouched: PMTiles and any request with a Range header (byte offsets must
//    reach the server unmodified), cross-origin requests, and anything outside this scope.
// It only ever deletes caches it owns ('skintrack-shell-*' older than the current version).
const VERSION = '0.1.0';
const SHELL_CACHE = `skintrack-shell-${VERSION}`;
const DATA_CACHE = 'skintrack-data';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  'app/config.js',
  'app/layers/avalanche-model.js',
  'app/layers/common.js',
  'app/layers/forecast.js',
  'app/layers/history.js',
  'app/layers/index.js',
  'app/layers/routes.js',
  'app/layers/snow.js',
  'app/layers/terrain.js',
  'app/lib/escape.js',
  'app/lib/geo.js',
  'app/lib/hash.js',
  'app/lib/net.js',
  'app/lib/terrain-math.js',
  'app/lib/time.js',
  'app/lib/units.js',
  'app/lib/validate.js',
  'app/main.js',
  'app/map/basemap-layers.js',
  'app/map/layers.js',
  'app/map/map.js',
  'app/map/style.js',
  'app/map/terrain.js',
  'app/map/tiles.js',
  'app/offline/packages.js',
  'app/offline/planner.js',
  'app/offline/store.js',
  'app/providers/caic.js',
  'app/providers/fetch.js',
  'app/providers/nws.js',
  'app/providers/openmeteo.js',
  'app/providers/snotel.js',
  'app/ui/app.css',
  'app/ui/conditions.css',
  'app/ui/conditions.js',
  'app/ui/dom.js',
  'app/ui/explore.js',
  'app/ui/inspector.js',
  'app/ui/layers-panel.js',
  'app/ui/locate.js',
  'app/ui/offline.js',
  'app/ui/saved.js',
  'app/ui/search.js',
  'app/ui/sheet.js',
  'app/ui/sources.js',
  'assets/glyphs/Noto Sans Italic/0-255.pbf',
  'assets/glyphs/Noto Sans Italic/256-511.pbf',
  'assets/glyphs/Noto Sans Italic/512-767.pbf',
  'assets/glyphs/Noto Sans Italic/768-1023.pbf',
  'assets/glyphs/Noto Sans Italic/8192-8447.pbf',
  'assets/glyphs/Noto Sans Medium/0-255.pbf',
  'assets/glyphs/Noto Sans Medium/256-511.pbf',
  'assets/glyphs/Noto Sans Medium/512-767.pbf',
  'assets/glyphs/Noto Sans Medium/768-1023.pbf',
  'assets/glyphs/Noto Sans Medium/8192-8447.pbf',
  'assets/glyphs/Noto Sans Regular/0-255.pbf',
  'assets/glyphs/Noto Sans Regular/256-511.pbf',
  'assets/glyphs/Noto Sans Regular/512-767.pbf',
  'assets/glyphs/Noto Sans Regular/768-1023.pbf',
  'assets/glyphs/Noto Sans Regular/8192-8447.pbf',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/sprite/light.json',
  'assets/sprite/light.png',
  'assets/sprite/light@2x.json',
  'assets/sprite/light@2x.png',
  'vendor/maplibre-contour-0.1.1/maplibre-contour.min.js',
  'vendor/maplibre-gl-5.24.0/maplibre-gl.css',
  'vendor/maplibre-gl-5.24.0/maplibre-gl.js',
  'vendor/pmtiles-4.5.0/pmtiles.js',
];
const SCOPE = new URL('./', self.location).href;
const SHELL_URLS = new Set(SHELL.map(p => new URL(p, SCOPE).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll([...SHELL_URLS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('skintrack-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Cache first, then refresh the cached copy from the network in the background. */
async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const key = request.mode === 'navigate' ? new URL('./', SCOPE).href : request.url.split('#')[0].split('?')[0];
  const hit = await cache.match(key);
  const refresh = fetch(request).then(res => { if (res.status === 200) cache.put(key, res.clone()); return res; });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
}

/**
 * Network first for small data, falling back to the data cache (also filled by offline packages). When a cached
 * copy exists it is served if the network has not answered within DATA_WAIT_MS, so a weak signal does not stall
 * the app (the page gives up on a request after 15 s and would never see the copy).
 */
const DATA_WAIT_MS = 4000;
async function data(request) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request.url);
  const net = fetch(request).then(res => {
    if (res.status === 200) cache.put(request.url, res.clone()).catch(() => {}); // never store partial (206) responses
    return res;
  });
  if (!hit) return net;
  return Promise.race([net, new Promise(resolve => setTimeout(resolve, DATA_WAIT_MS, hit))]).catch(() => hit);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range') || !req.url.startsWith(SCOPE)) return;
  const url = new URL(req.url);
  if (/\.pmtiles$/i.test(url.pathname)) return;
  const clean = url.origin + url.pathname;
  if (req.mode === 'navigate' || SHELL_URLS.has(clean)) { event.respondWith(shell(req)); return; }
  if (url.pathname.includes('/data/') && /\.(geo)?json$/i.test(url.pathname)) event.respondWith(data(req));
});
