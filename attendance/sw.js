// Star Swim Attendance — service worker.
//
// Caches the shell only. Attendance data and punches are NEVER cached: a
// stale roster or a replayed punch is worse than an error message, and a
// punch must reach the server to get a server timestamp.
var CACHE = 'ssb-attendance-v1';
var SHELL = [
  './', './index.html', './app.js', './config.js', './manifest.json',
  './logo.png', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Anything that is not our own shell (i.e. Supabase) goes straight to the
  // network, every time.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request).then(function (res) {
      // Keep the shell fresh when online.
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () { return caches.match(e.request); })
  );
});
