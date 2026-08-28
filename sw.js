/* Cache-first service worker for the sudoku app shell.
   Scope is the directory this file lives in: keep it beside index.html,
   never one level up, so it controls the whole app and nothing outside it. */
/* The placeholder below is replaced at build time with the commit SHA, so
   every deploy gets its own cache. A fixed name would pin every visitor to
   the first version they ever loaded, the failure this exists to prevent. */
const CACHE_NAME = 'sudoku-__BUILD__';
/* CacheStorage is keyed by origin, not by service worker scope. This site is a
   project page on an account domain shared with every other repository the same
   account publishes, so caches.keys() below hands back their caches too, and
   caches.match() would answer this app's request out of one of them. Both are
   namespaced through this prefix: only caches this app opened are read, and
   only those are deleted. */
const CACHE_PREFIX = 'sudoku-';
/* Every icon the manifest names belongs here. The fetch handler below is
   cache first with no runtime population, so a file that is not precached is
   never stored at all: an installed app that has been offline since it was
   added to the home screen would have no icon bytes to show. Five KB of PNG
   is a cheap price for that, and tests/assets.test.mjs keeps this list and
   the manifest from drifting apart. */
const APP_SHELL = [
  './',
  './index.html',
  /* The generator runs in a worker, and a worker script is fetched separately
     from the document that spawns it. Left out of here, an installed app that
     has been offline since it was added would load, show the difficulty picker,
     and fail on the first tap: the page is cached and the thing that builds the
     board is not. */
  './generator.js',
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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  /* Delete this app's older caches. Without this, a bumped CACHE_NAME leaves
     the old cache's entries on disk forever and each release only grows
     storage instead of replacing it. Scoped to CACHE_PREFIX: an unfiltered
     sweep here deletes the offline cache of every other site on the origin,
     which on a github.io account domain means every other project page. */
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  /* Matched inside this app's own cache, opened by name. ignoreSearch because
     the precached entry for the app root is './': a visitor who arrives on a
     link carrying a query string is asking for the same document, and
     without this the offline load misses the cache and fails. */
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(event.request, { ignoreSearch: true }))
      .then((cached) => cached || fetch(event.request)),
  );
});
