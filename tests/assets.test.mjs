/* The page stopped being a single file: it now ships a manifest, a service
   worker, an icon, an error page and site metadata.

   Two ways that breaks in production and in no local test: an asset exists in
   the repo but the deploy workflow never copies it into _site, or an asset is
   referenced from an absolute path. This is a project site served under a
   subdirectory of an account domain shared with another repo, so a leading
   slash resolves to that other site, not to this one. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const readBytes = (rel) => readFileSync(join(root, rel));

const html = read('index.html');
const workflow = read('.github/workflows/deploy-pages.yml');

/* Everything that must reach the published site. */
const PUBLISHED = [
  'index.html',
  '404.html',
  'manifest.webmanifest',
  'sw.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

/* LICENSE is deliberately not here. It is repository metadata, not site content:
   it must exist in the repo, since a public repo without one reserves all rights,
   but serving it from the game adds nothing. The build allowlist omits it. */

/* Everything that must not. */
const PRIVATE = ['tests', 'node_modules', 'package.json', 'package-lock.json', '.github'];

/* The paths sw.js promises to put in the cache on install. Parsed out of the
   source rather than imported, because importing a service worker into node
   runs its top level and registers listeners against globals that do not
   exist here. */
function appShell() {
  const sw = read('sw.js');
  return sw
    .slice(sw.indexOf('APP_SHELL'), sw.indexOf('];', sw.indexOf('APP_SHELL')))
    .match(/'([^']+)'/g)
    .map((s) => s.slice(1, -1));
}

/* A PNG opens with an 8 byte signature, then a length and the tag "IHDR",
   whose first eight bytes of data are the width and the height as big endian
   32 bit integers. Reading them is 4 lines and needs no dependency, and it is
   the only way to tell that a file called icon-512.png holds 512 pixels.
   tests/typography.test.mjs now trusts the .png extension to mean binary, so
   the extension being honest is worth an assertion of its own. */
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
  /* This used to grep an inline "cp index.html ... _site/" step. Assembly now
     lives in scripts/build.mjs, so the deploy and the pull request publish the
     same tree and CI exercises it. Assert the workflow delegates rather than
     re-implementing the copy, and that the allowlist covers what exists. */
  assert.ok(
    /run:\s*npm run build/.test(workflow),
    'the deploy workflow no longer builds through npm run build',
  );
  assert.ok(
    !/cp\s+index\.html/.test(workflow),
    'the deploy workflow still copies assets inline, which CI never exercises',
  );
  assert.ok(
    !/cp\s+-R?\s*\.\s+_site/.test(workflow),
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
  /* The cache name carries the __BUILD__ placeholder, which the build replaces
     with the commit SHA. That is strictly stronger than a hand bumped -vN,
     which only changes when somebody remembers to change it. */
  assert.ok(
    /CACHE_NAME\s*=\s*'sudoku-__BUILD__'/.test(sw),
    'the cache name no longer carries the build placeholder, so every deploy would reuse one cache',
  );
});

/* tests/site.test.mjs checks the precache list in one direction only: nothing
   named there may be missing. This is the other direction. An icon that ships
   and is advertised but never cached is invisible until somebody installs the
   app and goes offline, which is the one scenario a service worker exists for. */
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
    /* One size per entry here, so the declaration compares whole. A list of
       sizes would be legal in a manifest and is not what this repository
       ships. */
    assert.equal(
      pngSize(icon.src),
      icon.sizes,
      `${icon.src} declares ${icon.sizes} and is not that size`,
    );
  }
});

/* og:image is the one URL in this repository that has to be absolute, which
   puts it outside every relative-path check the suite has. Its declared
   dimensions are read by the scrapers that reserve the preview box before the
   image arrives, so they have to match the bytes.
   tests/site.test.mjs proves the URL resolves to a published file. */
test('the social preview image agrees with the file it names', () => {
  const meta = (attr, key) =>
    html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]+)">`))?.[1];

  const image = meta('property', 'og:image');
  assert.ok(image, 'no og:image');
  assert.equal(meta('name', 'twitter:image'), image, 'the two social images disagree');

  const rel = image.replace(/^https:\/\/[^/]+\/sudoku\//, '');
  assert.notEqual(rel, image, 'og:image is not under the canonical origin');
  assert.equal(
    pngSize(rel),
    `${meta('property', 'og:image:width')}x${meta('property', 'og:image:height')}`,
    `${rel} is not the size og:image:width and og:image:height promise`,
  );
});

test('index.html links the manifest and registers the worker relatively', () => {
  const manifestLink = html.match(/<link rel="manifest" href="([^"]+)">/);
  assert.ok(manifestLink, 'index.html does not link a manifest');
  assert.equal(manifestLink[1], 'manifest.webmanifest');

  const register = html.match(/serviceWorker\.register\('([^']+)'\)/);
  assert.ok(register, 'index.html never registers the service worker');
  assert.equal(register[1], './sw.js');
  assert.ok(
    html.includes("'serviceWorker' in navigator"),
    'the registration is not feature-guarded',
  );
});

test('no shipped file points at an absolute path or hardcodes the subdirectory', () => {
  const offences = [];

  for (const rel of ['index.html', '404.html', 'sw.js', 'manifest.webmanifest', 'icons/icon.svg']) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        /* data: URIs are self-contained and carry no path at all. */
        const stripped = line.replace(/(href|src)="data:[^"]*"/g, '');
        for (const re of [/(?:href|src)="\//, /"\/sudoku/, /'\/sudoku/]) {
          if (re.test(stripped)) offences.push(`${rel}:${i + 1} ${line.trim().slice(0, 90)}`);
        }
      });
  }

  assert.deepEqual(offences, [], `use a relative path instead:\n  ${offences.join('\n  ')}`);
});

test('the head declares a content security policy and a theme colour', () => {
  const head = html.slice(0, html.indexOf('</head>'));

  const csp = head.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'no CSP meta tag');
  for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(directive), `CSP is missing ${directive}`);
  }
  /* The page is one inline script and one inline style, and both are covered
     by the policy: without these two the app would not run at all. */
  assert.ok(/script-src [^;]*'unsafe-inline'/.test(csp[1]));
  assert.ok(/style-src [^;]*'unsafe-inline'/.test(csp[1]));

  /* The service worker is a same-origin script file, not an inline one. It is
     governed by worker-src, which falls back to script-src (and then to
     default-src) in browsers that do not implement it, so both have to allow
     'self' or registration is blocked and the app silently loses offline. */
  assert.ok(/script-src [^;]*'self'/.test(csp[1]), "script-src must allow 'self' for sw.js");
  assert.ok(/worker-src [^;]*'self'/.test(csp[1]), "worker-src must allow 'self' for sw.js");
  assert.ok(/default-src 'self'/.test(csp[1]), "default-src 'none' would block the manifest");

  /* The manifest's theme_color and this meta tag colour the same surface: the
     title bar when the app is installed, the browser UI when it is a tab. They
     drifted apart once (manifest vermilion, page cream), which showed up as a
     red title bar over a cream page, so they are pinned to each other here
     rather than to a literal. Change both or neither. */
  const themeColor = head.match(/<meta name="theme-color" content="([^"]+)"/);
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

/* Every interactive element in the app draws its own focus ring. The error page
   is a separate document with its own stylesheet, so it silently misses out. */
test('the error page gives its only link a focus ring', () => {
  const notFound = read('404.html');

  assert.match(
    notFound,
    /a:focus-visible\{[^}]*outline:/,
    'the 404 link has no focus-visible outline',
  );
});

/* The icon sprite is Apache-2.0 and travels inside the published index.html, so
   the attribution has to travel with it, not only sit in the repo. */
test('the Apache-2.0 icon sprite carries its attribution', () => {
  assert.ok(existsSync(join(root, 'NOTICE')), 'no NOTICE file');
  const notice = read('NOTICE');
  assert.match(notice, /Material Symbols/);
  assert.match(notice, /Apache License, Version 2\.0/);

  assert.match(html, /Material Symbols[^]{0,200}Apache/, 'index.html ships icons unattributed');
});
