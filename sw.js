/*
 * Xiangqi service worker.
 *
 * Cache-first: every local asset is precached on install, so after the first
 * visit the app starts and runs with no network at all. When the network is
 * available, cached files are refreshed in the background for the next launch.
 *
 * Bump CACHE_VERSION on every release so installed apps pick up a clean cache.
 */
const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = `xiangqi-${CACHE_VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/glyphs.js',
  '/game.js',
  '/ui.js',
  '/manifest.json',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // `reload` bypasses the HTTP cache so a new version never precaches stale files.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('xiangqi-') && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function refresh(cache, request) {
  return fetch(request).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Any navigation is answered with the app shell.
    const key = request.mode === 'navigate' ? '/index.html' : request;
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(refresh(cache, key).catch(() => {}));
      return cached;
    }
    try {
      return await refresh(cache, request);
    } catch (err) {
      // Offline and not cached: fall back to the shell for pages.
      const shell = await cache.match('/index.html');
      if (shell && request.mode === 'navigate') return shell;
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
