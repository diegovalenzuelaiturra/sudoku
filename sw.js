/* Cache-first service worker for the sudoku app shell.
   Scope is the directory this file lives in: keep it beside index.html,
   never one level up, so it controls the whole app and nothing outside it. */
/* The placeholder below is replaced at build time with the commit SHA, so
   every deploy gets its own cache. A fixed name would pin every visitor to
   the first version they ever loaded, the failure this exists to prevent. */
const CACHE_NAME = 'sudoku-__BUILD__';
/* Every icon the manifest names belongs here. The fetch handler below is
   cache first with no runtime population, so a file that is not precached is
   never stored at all: an installed app that has been offline since it was
   added to the home screen would have no icon bytes to show. Five KB of PNG
   is a cheap price for that, and tests/assets.test.mjs keeps this list and
   the manifest from drifting apart. */
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  /* Take over from any waiting-to-activate previous worker immediately;
     paired with clients.claim() below so a fresh deploy is not stuck
     behind an already-open tab running the old script. */
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  /* Delete every cache that is not this version's name. Without this,
     a bumped CACHE_NAME leaves the old cache's entries on disk forever
     and each release only grows storage instead of replacing it. */
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
