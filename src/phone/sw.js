/* ==========================================================================
   LANBeam phone service worker — minimal offline shell.
   Purpose: make the installed home-screen app open instantly and survive a
   momentarily busy desktop. API traffic (/api/*) is NEVER intercepted —
   transfers must always hit the real server.
   NOTE: plain-HTTP LAN origins are not secure contexts, so browsers may
   refuse registration entirely — that's fine, the app works without it.
   ========================================================================== */

const CACHE = 'lanbeam-shell-v1';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Pass everything else straight to the network: API calls, fonts, the
  // pairing page with its token query, range downloads — all live-only.
  if (event.request.method !== 'GET') return;
  if (!SHELL.includes(url.pathname)) return;

  // Shell assets: cache-first, revalidate in the background is overkill for
  // a LAN app — the server sends no-cache headers anyway when online.
  event.respondWith(
    caches.match(url.pathname === '/' ? '/' : url.pathname).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
