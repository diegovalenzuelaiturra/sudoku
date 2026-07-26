/* Static file server for the Playwright run.

   Two things it has to get right:

   1. It serves _site, the build output, and nothing else. Serving the
      repository root instead would put package.json, tests/, .github/ and
      node_modules on the wire, and, worse, would let the browser suite pass
      against source files that the allowlist never publishes. The browser now
      loads the same bytes the deploy uploads.
   2. It mounts that directory under a path prefix, because the site is
      published as a GitHub Pages project site at /sudoku/ and not at the
      account root. A leading slash in an asset path resolves against a
      different repository in production and quietly 404s; serving at / here
      would hide that, so the prefix reproduces it.

   Written by hand rather than pulled from npm on purpose: the install runs with
   --ignore-scripts to keep the supply chain small, and adding a package tree to
   serve one file would work against that. */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '_site');
/* Argument first, then the environment, then the default. That order matters:
   e2e/boot.spec.mjs passes the literal '0' to have the OS pick a free port,
   and reading the environment first would drag that second server onto the
   port the suite is already using. PLAYWRIGHT_PORT is the one knob that moves
   both this server and the Playwright config, so previewing and testing can be
   pointed at another port together. */
const PORT = Number(process.argv[2] || process.env.PLAYWRIGHT_PORT || 4173);
/* Defaults to the prefix this site is actually published under. Serving at the
   root instead is the configuration this file exists to avoid, so it is not
   something a caller should get by saying nothing; pass '/' to ask for it.
   Normalised to always start and end with a slash, so the prefix arithmetic
   below has one shape to deal with. */
const BASE = `/${(process.argv[3] ?? 'sudoku').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function plain(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/* Pages answers an unknown path under the site with the published 404.html and
   a 404 status, leaving the address bar on the path that was asked for. A plain
   text body here instead would mean the error page is the one published file
   the browser suite can never open, and that its only link is never resolved
   from the depth a real 404 is served at. */
function notFound(req, res) {
  const page = resolve(ROOT, '404.html');
  if (!existsSync(page)) return plain(res, 404, 'not found');
  res.writeHead(404, {
    'content-type': TYPES.get('.html'),
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(page).pipe(res);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
  } catch {
    return plain(res, 400, 'bad request');
  }

  /* /sudoku is the site, /sudoku/ is the directory: send the browser to the
     form the relative paths inside index.html are resolved against. */
  if (BASE !== '/' && `${pathname}/` === BASE) {
    res.writeHead(301, { location: BASE });
    return res.end();
  }
  /* Outside the prefix is outside the site: Pages would be serving some other
     repository there, not this one's error page. */
  if (!pathname.startsWith(BASE)) return plain(res, 404, 'not found');

  /* resolve() collapses any .. segments, so the containment check below sees
     the real target and a crafted path cannot walk out of the repository. */
  let file = resolve(ROOT, pathname.slice(BASE.length));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return plain(res, 403, 'forbidden');

  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      file = resolve(file, 'index.html');
      info = await stat(file);
    }
  } catch {
    return notFound(req, res);
  }

  res.writeHead(200, {
    'content-type': TYPES.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'content-length': info.size,
    /* Every test starts from the file on disk, never from a copy the browser
       or a service worker kept from an earlier test. */
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

/* Nothing to serve means every spec fails on a 404 and none of them says why,
   so say it once and here. */
if (!existsSync(ROOT)) {
  process.stderr.write(`${ROOT} does not exist; run npm run build first\n`);
  process.exit(1);
}

/* Bound to the loopback interface only: a test fixture has no business being
   reachable from the network. */
server.listen(PORT, '127.0.0.1', () => {
  /* The port that was bound, not the one that was asked for: a caller that
     passes 0, to take whatever port is free rather than collide with another
     run, learns which one it got from this line. */
  process.stdout.write(`serving ${ROOT} on http://127.0.0.1:${server.address().port}${BASE}\n`);
});
