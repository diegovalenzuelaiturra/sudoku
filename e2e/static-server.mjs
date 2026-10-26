import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '_site');
const PORT = Number(process.argv[2] || process.env.PLAYWRIGHT_PORT || 4173);
const BASE = `/${(process.argv[3] ?? 'sudoku').replace(/^\/+|\/+$/gu, '')}/`.replace('//', '/');

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
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

if (!existsSync(ROOT)) {
  process.stderr.write(`${ROOT} does not exist; run npm run build first\n`);
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`serving ${ROOT} on http://127.0.0.1:${server.address().port}${BASE}\n`);
});
