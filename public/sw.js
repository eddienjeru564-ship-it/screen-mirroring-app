// sw.js — service worker that makes ScreenView installable as an app.
//
// Strategy: network-first for the static app shell, so a running server always
// serves the latest code; the cache is only a fallback when the server can't be
// reached. The API (/api, which also carries signaling) is never cached.

const CACHE = 'screenview-v2';
const SHELL = [
  '/', '/host', '/view', '/admin',
  '/styles.css', '/app.js', '/rtc.js', '/signal.js', '/host.js', '/view.js', '/admin.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.search) return; // e.g. /host?test=1 — always straight to the network

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
  );
});
