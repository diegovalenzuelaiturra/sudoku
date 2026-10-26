import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const readBytes = (rel) => readFileSync(join(root, rel));

const html = read('index.html');
const app = read('app.js');
const workflow = read('.github/workflows/deploy-pages.yml');

const PUBLISHED = [
  'index.html',
  '404.html',
  'manifest.webmanifest',
  'sw.js',
  'generator.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const NOT_PRECACHED = {
  'sw.js':
    'the browser fetches a service worker script itself, on registration and on every ' +
    'update check, and never routes that request through the fetch handler',
  '404.html':
    'GitHub Pages sends it as the body of a 404 for a path that does not exist, so no ' +
    'request names it and a cache entry under its own path would never be matched',
};

const PRIVATE = ['tests', 'node_modules', 'package.json', 'package-lock.json', '.github'];

/* The paths sw.js promises to put in the cache on install. Parsed out of the
   source rather than imported, because importing a service worker into node
   runs its top level and registers listeners against globals that do not
   exist here. */
function appShell() {
  const sw = read('sw.js');
  return sw
    .slice(sw.indexOf('APP_SHELL'), sw.indexOf('];', sw.indexOf('APP_SHELL')))
    .match(/'([^']+)'/gu)
    .map((s) => s.slice(1, -1));
}

/* A PNG opens with an 8 byte signature, then a length and the tag "IHDR",
   whose first eight bytes of data are the width and the height as big endian
   32 bit integers. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(rel) {
  const bytes = readBytes(rel);
  assert.ok(bytes.length > 24, `${rel} is too short to be a PNG`);
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${rel} is not a PNG`);
  assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR', `${rel} has no header chunk`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test('every published asset exists in the repo', () => {
  for (const rel of PUBLISHED) {
    assert.ok(existsSync(join(root, rel)), `${rel} is referenced but missing`);
  }
});

test('the deploy workflow builds through the same script CI runs', async () => {
  assert.ok(
    /run:\s*npm run build/u.test(workflow),
    'the deploy workflow no longer builds through npm run build',
  );
  assert.ok(
    !/cp\s+index\.html/u.test(workflow),
    'the deploy workflow still copies assets inline, which CI never exercises',
  );
  assert.ok(
    !/cp\s+-R?\s*\.\s+_site/u.test(workflow),
    'the deploy workflow copies the whole checkout',
  );

  const { ALLOWLIST } = await import('../scripts/build.mjs');
  const allowed = new Set(ALLOWLIST.map((e) => e.path));
  for (const rel of PUBLISHED) {
    const needle = rel.includes('/') ? rel.split('/')[0] : rel;
    assert.ok(allowed.has(needle), `${rel} exists but the build allowlist omits it`);
  }
  for (const rel of PRIVATE) {
    assert.ok(!allowed.has(rel), `the build allowlist publishes ${rel}`);
  }
});

test('the manifest is valid JSON and keeps every path relative', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  assert.equal(manifest.name, 'Sudoku');
  assert.equal(manifest.display, 'standalone');
  for (const key of ['start_url', 'scope']) {
    assert.ok(manifest[key].startsWith('./'), `manifest ${key} is not relative: ${manifest[key]}`);
  }
  assert.ok(manifest.icons.length > 0, 'manifest declares no icons');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), `manifest icon src is absolute: ${icon.src}`);
    assert.ok(existsSync(join(root, icon.src)), `manifest icon ${icon.src} does not exist`);
  }
});

test('the service worker precaches relative paths that all exist', () => {
  const sw = read('sw.js');
  const shell = appShell();

  assert.ok(shell.length >= 4, 'the app shell precache list looks empty');
  for (const entry of shell) {
    assert.ok(entry.startsWith('./'), `service worker precaches an absolute path: ${entry}`);
    if (entry !== './') {
      assert.ok(existsSync(join(root, entry)), `service worker precaches missing ${entry}`);
    }
  }
  assert.ok(
    /CACHE_NAME\s*=\s*'sudoku-__BUILD__'/u.test(sw),
    'the cache name no longer carries the build placeholder, so every deploy would reuse one cache',
  );
});

test('the service worker precaches every published file it can serve', () => {
  const shell = new Set(appShell());

  for (const rel of PUBLISHED) {
    if (Object.hasOwn(NOT_PRECACHED, rel)) {
      assert.ok(!shell.has(`./${rel}`), `${rel} is precached and also listed as not precached`);
    } else {
      assert.ok(
        shell.has(`./${rel}`),
        `${rel} is published but the app shell never caches it, so the installed app ` +
          'loses it offline. Add it to APP_SHELL in sw.js, or to NOT_PRECACHED with the reason',
      );
    }
  }
  for (const rel of Object.keys(NOT_PRECACHED)) {
    assert.ok(PUBLISHED.includes(rel), `NOT_PRECACHED names ${rel}, which is not published`);
  }
});

test('the service worker precaches every icon the manifest names', () => {
  const shell = new Set(appShell());
  const manifest = JSON.parse(read('manifest.webmanifest'));

  for (const icon of manifest.icons) {
    assert.ok(
      shell.has(`./${icon.src}`),
      `the manifest advertises ${icon.src} but the app shell never caches it, ` +
        'so an installed app that has been offline since it was added has no icon',
    );
  }
});

/* A manifest entry is a claim about a file the browser has not read yet: the
   browser picks an icon by the declared size and only then fetches it, so a
   192 declared as 512 is chosen for the splash screen and drawn blurry. */
test('every raster icon really is a PNG of the size the manifest declares', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const rasters = manifest.icons.filter((icon) => icon.src.toLowerCase().endsWith('.png'));

  assert.equal(rasters.length, 2, 'the two raster icons are what maskable install prompts use');
  for (const icon of rasters) {
    assert.equal(icon.type, 'image/png', `${icon.src} is declared as ${icon.type}`);
    assert.equal(
      pngSize(icon.src),
      icon.sizes,
      `${icon.src} declares ${icon.sizes} and is not that size`,
    );
  }
});

test('the social preview image agrees with the file it names', () => {
  const meta = (attr, key) =>
    html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]+)">`, 'u'))?.[1];

  const image = meta('property', 'og:image');
  assert.ok(image, 'no og:image');
  assert.equal(meta('name', 'twitter:image'), image, 'the two social images disagree');

  const rel = image.replace(/^https:\/\/[^/]+\/sudoku\//u, '');
  assert.notEqual(rel, image, 'og:image is not under the canonical origin');
  assert.equal(
    pngSize(rel),
    `${meta('property', 'og:image:width')}x${meta('property', 'og:image:height')}`,
    `${rel} is not the size og:image:width and og:image:height promise`,
  );
});

test('index.html links the manifest and registers the worker relatively', () => {
  const manifestLink = html.match(/<link rel="manifest" href="([^"]+)">/u);
  assert.ok(manifestLink, 'index.html does not link a manifest');
  assert.equal(manifestLink[1], 'manifest.webmanifest');

  const register = app.match(/serviceWorker\s*\.\s*register\(\s*'([^']+)'/u);
  assert.ok(register, 'app.js never registers the service worker');
  assert.equal(register[1], './sw.js');
  assert.ok(
    app.includes("'serviceWorker' in navigator"),
    'the registration is not feature-guarded',
  );
});

test('index.html asks for app.js and stats.js, and the build inlines both', async () => {
  assert.match(html, /<script src="app\.js"><\/script>/u, 'index.html no longer loads app.js');
  assert.match(html, /<script src="stats\.js"><\/script>/u, 'index.html no longer loads stats.js');

  const { ALLOWLIST } = await import('../scripts/build.mjs');
  assert.ok(
    !ALLOWLIST.some((entry) => entry.path === 'app.js'),
    'app.js is inlined into the page, so publishing it as well ships the game twice',
  );
  assert.ok(
    !ALLOWLIST.some((entry) => entry.path === 'stats.js'),
    'stats.js is inlined into the page, so publishing it as well ships it twice',
  );
});

test('no shipped file points at an absolute path or hardcodes the subdirectory', () => {
  const offences = [];

  for (const rel of [
    'index.html',
    '404.html',
    'app.js',
    'stats.js',
    'sw.js',
    'manifest.webmanifest',
    'icons/icon.svg',
  ]) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        const stripped = line.replace(/(href|src)="data:[^"]*"/gu, '');
        for (const re of [/(?:href|src)="\//u, /"\/sudoku/u, /'\/sudoku/u]) {
          if (re.test(stripped)) offences.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
        }
      });
  }

  assert.deepEqual(offences, [], `use a relative path instead:\n  ${offences.join('\n  ')}`);
});

test('the head declares a content security policy and a theme colour', () => {
  const head = html.slice(0, html.indexOf('</head>'));

  const csp = head.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/u);
  assert.ok(csp, 'no CSP meta tag');
  for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  assert.ok(/script-src [^;]*'unsafe-inline'/u.test(csp[1]));
  assert.ok(/style-src [^;]*'unsafe-inline'/u.test(csp[1]));

  /* The service worker is a same-origin script file, not an inline one. It is
     governed by worker-src, which falls back to script-src (and then to
     default-src) in browsers that do not implement it, so both have to allow
     'self' or registration is blocked and the app silently loses offline. */
  assert.ok(/script-src [^;]*'self'/u.test(csp[1]), "script-src must allow 'self' for sw.js");
  assert.ok(/worker-src [^;]*'self'/u.test(csp[1]), "worker-src must allow 'self' for sw.js");
  assert.ok(/default-src 'self'/u.test(csp[1]), "default-src 'none' would block the manifest");

  const themeColor = head.match(/<meta name="theme-color" content="([^"]+)"/u);
  assert.ok(themeColor, 'no theme-color');
  assert.equal(
    JSON.parse(read('manifest.webmanifest')).theme_color,
    themeColor[1],
    'the manifest theme_color and the page theme-color must match',
  );
  assert.ok(head.includes('property="og:title"'), 'no Open Graph title');
  assert.ok(head.includes('name="twitter:card"'), 'no Twitter card');
  assert.ok(
    !head.includes('Un solo archivo'),
    'the description still claims the site is a single file',
  );
});

test('the error page gives its only link a focus ring', () => {
  const notFound = read('404.html');

  assert.match(
    notFound,
    /a:focus-visible\{[^}]*outline:/u,
    'the 404 link has no focus-visible outline',
  );
});

/* The icon sprite is Apache-2.0 and travels inside the published index.html, so
   the attribution has to travel with it, not only sit in the repo. */
test('the Apache-2.0 icon sprite carries its attribution', () => {
  assert.ok(existsSync(join(root, 'NOTICE')), 'no NOTICE file');
  const notice = read('NOTICE');
  assert.match(notice, /Material Symbols/u);
  assert.match(notice, /Apache License, Version 2\.0/u);

  assert.match(html, /Material Symbols[\s\S]{0,200}Apache/u, 'index.html ships icons unattributed');
});
