// Star Swim — the parent app's service worker.
//
// Caches the shell so the app opens without a connection, and NOTHING
// else. A schedule, a balance or a message read from a cache is worse
// than a spinner: a parent acting on last week's timetable turns up on
// the wrong day, and a payment that has cleared still showing as owing
// starts a phone call.
//
// Network-first for everything on this origin, cache only as the
// fallback when the network fails outright. That also means a redirect
// or a rewrite at the CDN is followed, which is what lets this app live
// at app.mystarswim.com and in /parent at the same time.
//
// Must match BUILD in app.js.
var BUILD = 1;
var CACHE = 'ssb-parent-v' + BUILD;
var SHELL = ['./', './index.html', './app.js', './config.js', './manifest.json',
             './logo.png', './icon-192.png', './icon-512.png'];

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
  // Supabase, and anything else off this origin, is never touched.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () { return caches.match(e.request); })
  );
});
