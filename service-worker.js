// Service Worker mínimo para PWA instalable
// No cachea nada - tu app siempre carga desde Apps Script en tiempo real

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', function(event) {
  // No intercepta nada - deja pasar todo directo a Apps Script
  return;
});
