const CACHE_PREFIX = 'maxica-ruta-shell-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-22-3';
const scope = new URL(self.registration.scope);
const shell = new URL('index.html', scope).href;
const assets = ['index.html', 'reopen.js', 'manifest.json', 'icon-192.png', 'icon-512.png']
  .map(function (file) { return new URL(file, scope).href; });

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(assets.map(function (url) { return new Request(url, { cache: 'reload' }); }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(function (key) { return key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME; })
      .map(function (key) { return caches.delete(key); }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', function (event) {
  const port = event.ports[0];
  if (!port || !event.data || event.data.type !== 'maxica:rutas-worker-status') return;

  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    const saved = await Promise.all(assets.map(function (url) { return cache.match(url); }));
    if (saved.every(Boolean)) port.postMessage({ type: 'maxica:rutas-worker-ready', version: 1 });
  })());
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;

  const entry = url.origin + url.pathname;
  const launch = request.mode === 'navigate' && (entry === scope.href || entry === shell);
  if (!launch && !assets.includes(entry)) return;

  event.respondWith((async function () {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(launch ? shell : entry);
    return response || fetch(request);
  })());
});
