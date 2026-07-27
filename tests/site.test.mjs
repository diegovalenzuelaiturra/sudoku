/* What ships is not what is in the repository, it is what lands in _site, and
   every failure this file catches is invisible in a source diff: a path that
   resolves on a laptop and 404s in production.

   Two traps in particular. GitHub Pages serves this repository as a project
   site under /sudoku/, so a reference that starts with a slash resolves against
   a different repository at the account root, loads nothing, and logs nothing.
   And macOS matches filenames without regard to case while the Pages server
   does not, so Icon.png happily resolves locally and 404s once deployed.

   The manifest, the service worker and their icons are optional on purpose:
   they are landing on a sibling branch, so anything absent is skipped rather
   than failed, and starts being enforced the moment it appears. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = join(import.meta.dirname, '..');
const siteDir = join(root, '_site');
const buildScript = join(root, 'scripts', 'build.mjs');

/* Built into the real _site rather than a temp directory: these assertions are
   worth most when they run against the exact bytes the deploy uploads. */
const build = existsSync(buildScript)
  ? spawnSync(process.execPath, [buildScript], { cwd: root, encoding: 'utf8', timeout: 120000 })
  : null;

const haveSite = existsSync(siteDir) && statSync(siteDir).isDirectory();
const buildFailed = build !== null && (build.error !== undefined || build.status !== 0);

/* Everything below inspects the build output, so a failed or absent build makes
   those checks meaningless rather than false: skip them and let the one test
   that owns the build report it. */
const checkable = haveSite && !buildFailed;
const SKIPPED = buildFailed
  ? 'the build failed, see "the build assembles a publishable _site"'
  : 'no _site to check yet, scripts/build.mjs has not landed';

/* Where a manifest or a service worker sits when nothing in the HTML points at
   one. Checked in addition to whatever the HTML references, so an orphan file
   that ships but is never registered is still held to the same rules. */
const MANIFEST_NAMES = ['manifest.webmanifest', 'site.webmanifest', 'manifest.json'];
const WORKER_NAMES = ['sw.js', 'service-worker.js', 'serviceworker.js'];

/* The deploy publishes _site verbatim, so anything below is world readable. */
const PRIVATE = new Set([
  'tests',
  'node_modules',
  'package.json',
  'package-lock.json',
  '.github',
  '.git',
  'scripts',
]);

const ASSET =
  /\.(?:html|js|mjs|css|json|webmanifest|map|txt|xml|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/iu;

/* navigator.serviceWorker.register lives inside an inline script, so it is not
   an attribute and the attribute sweep cannot see it. */
const REGISTER = /serviceWorker\s*\.\s*register\s*\(\s*['"`]([^'"`\n]+)['"`]/gu;

/* The published HTML is swept for start tags rather than parsed into a DOM.
   That sweep was the only thing this repository ever needed a DOM for, and it
   is not worth a dependency: the questions that genuinely need one are asked of
   a real browser in e2e/. Comments and the bodies of <script> and <style> are
   dropped first, so a path written inside a string literal is not mistaken for
   a reference the browser would resolve, while the start tags themselves stay,
   so <script src> is still swept. */
const COMMENT = /<!--[\s\S]*?-->/gu;
const RAW_TEXT = /(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/giu;
const START_TAG =
  /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)*)\s*\/?>/gu;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/gu;

/* Attributes are written escaped and read back decoded, which is the form
   getAttribute() hands over and the form a path has to be checked in. */
const ENTITY = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/gu;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/* Array literals holding nothing but strings and commas, which is what a
   precache list looks like. Anything cleverer needs a parser, and anything
   looser starts flagging cache names and header values. An array this misses is
   a check not run; an array it invents is a red build for no reason. */
const QUOTED = '(?:\'[^\'\\n]*\'|"[^"\\n]*"|`[^`\\n]*`)';
const STRING_ARRAY = new RegExp(`\\[\\s*(${QUOTED}(?:\\s*,\\s*${QUOTED})*\\s*,?)\\s*\\]`, 'gu');
const QUOTED_ITEM = new RegExp(QUOTED, 'gu');

const show = (file) => relative(root, file).split(sep).join('/');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function decodeEntities(value) {
  return value.replace(ENTITY, (whole, decimal, hex, name) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole;
    const point = decimal !== undefined ? Number(decimal) : parseInt(hex, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

/* Every start tag in the document, named in lower case, with its attributes.
   A repeated attribute keeps the first value, the way a browser does. */
function* startTags(source) {
  const markup = source.replace(COMMENT, '').replace(RAW_TEXT, (_whole, open) => open);
  for (const [, name, written] of markup.matchAll(START_TAG)) {
    const attrs = new Map();
    for (const [, key, quoted, single, bare] of written.matchAll(ATTRIBUTE)) {
      const attr = key.toLowerCase();
      if (attrs.has(attr)) continue;
      attrs.set(attr, decodeEntities(quoted ?? single ?? bare ?? ''));
    }
    yield { name: name.toLowerCase(), attrs };
  }
}

/* Anything carrying a scheme (https:, data:, mailto:, blob:) is somebody else's
   server, and a bare fragment never leaves the page. Everything else is ours. */
function localValue(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  return value;
}

/* Query and fragment are the server's business, not the filesystem's. */
function toPath(from, value) {
  const bare = value.split('#')[0].split('?')[0];
  if (bare === '') return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* A malformed escape is not a path we can check; the raw form still gets
       the leading slash and existence checks below. */
  }
  return resolve(dirname(from), decoded);
}

/* existsSync answers the case insensitive question on macOS, which is the wrong
   question: Pages compares bytes. Walk the real directory entries instead.
   Normalised because macOS hands back decomposed accents that no HTML has. */
function existsExactCase(target) {
  const rel = relative(siteDir, target);
  if (rel === '') return existsSync(target);
  let current = siteDir;
  for (const segment of rel.split(sep)) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return false;
    }
    const match = entries.find((e) => e.normalize('NFC') === segment.normalize('NFC'));
    if (match === undefined) return false;
    current = join(current, match);
  }
  return true;
}

let cached = null;

/* One pass over the published tree, shared by every test below. */
function inspect() {
  if (cached) return cached;

  const pages = walk(siteDir).filter((f) => /\.x?html$/iu.test(f));
  const pageRefs = [];
  const manifestFiles = new Set();
  const workerFiles = new Set();

  for (const file of pages) {
    const source = readFileSync(file, 'utf8');

    for (const { name: tag, attrs } of startTags(source)) {
      const relTokens = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u);

      for (const attr of ['src', 'href']) {
        if (!attrs.has(attr)) continue;
        const value = attrs.get(attr);
        pageRefs.push({ file, where: `<${tag} ${attr}>`, value });

        if (tag === 'link' && attr === 'href' && relTokens.includes('manifest')) {
          const target = localTarget(file, value);
          if (target) manifestFiles.add(target);
        }
      }
    }

    for (const [, value] of source.matchAll(REGISTER)) {
      pageRefs.push({ file, where: 'serviceWorker.register()', value });
      const target = localTarget(file, value);
      if (target) workerFiles.add(target);
    }
  }

  for (const name of MANIFEST_NAMES) {
    if (existsSync(join(siteDir, name))) manifestFiles.add(join(siteDir, name));
  }
  for (const name of WORKER_NAMES) {
    if (existsSync(join(siteDir, name))) workerFiles.add(join(siteDir, name));
  }

  const manifests = [...manifestFiles].filter((f) => existsSync(f));
  const workers = [...workerFiles].filter((f) => existsSync(f));
  const manifestErrors = [];
  const manifestRefs = [];
  const workerRefs = [];

  for (const file of manifests) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      manifestErrors.push(`${show(file)} is not valid JSON: ${e.message}`);
      continue;
    }
    const icons = Array.isArray(data?.icons) ? data.icons : [];
    icons.forEach((icon, i) => {
      if (typeof icon?.src === 'string') {
        manifestRefs.push({ file, where: `icons[${i}].src`, value: icon.src });
      }
    });
    /* start_url and scope are the classic project page mistake: "/" looks right
       and installs the wrong site. */
    for (const key of ['start_url', 'scope']) {
      if (typeof data?.[key] === 'string') {
        manifestRefs.push({ file, where: key, value: data[key] });
      }
    }
  }

  for (const file of workers) {
    const source = readFileSync(file, 'utf8');
    for (const [, body] of source.matchAll(STRING_ARRAY)) {
      for (const [token] of body.matchAll(QUOTED_ITEM)) {
        const value = token.slice(1, -1);
        if (looksLikePath(value)) workerRefs.push({ file, where: 'precache list', value });
      }
    }
  }

  cached = { pages, pageRefs, manifests, manifestErrors, manifestRefs, workers, workerRefs };
  return cached;
}

function localTarget(from, raw) {
  const value = localValue(raw);
  if (value === null || value.startsWith('/')) return null;
  return toPath(from, value);
}

/* Keeps 'sudoku-cache-v3' and 'no-store' out of the precache list. */
function looksLikePath(raw) {
  const value = localValue(raw);
  if (value === null) return false;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  if (value === '.' || value.endsWith('/')) return true;
  return ASSET.test(value.split('#')[0].split('?')[0]);
}

/* Every reference that should resolve to a file inside _site, and does not. */
function missing(refs) {
  const offences = [];

  for (const ref of refs) {
    const value = localValue(ref.value);
    /* A rooted reference is reported by its own test; resolving it here would
       only produce a second, less useful message. */
    if (value === null || value.startsWith('/')) continue;

    const target = toPath(ref.file, value);
    if (target === null) continue;

    const inSite = relative(siteDir, target);
    if (inSite.startsWith('..') || isAbsolute(inSite)) {
      offences.push(`${show(ref.file)} ${ref.where} "${ref.value}" climbs out of _site`);
      continue;
    }
    if (!existsExactCase(target)) {
      const wanted = inSite === '' ? '_site' : `_site/${inSite.split(sep).join('/')}`;
      const why = existsSync(target)
        ? 'which ships under a different capitalisation, and Pages compares case while macOS does not'
        : 'which is not published';
      offences.push(`${show(ref.file)} ${ref.where} "${ref.value}" wants ${wanted}, ${why}`);
      continue;
    }
    if (statSync(target).isDirectory() && !existsExactCase(join(target, 'index.html'))) {
      offences.push(
        `${show(ref.file)} ${ref.where} "${ref.value}" points at a directory with no index.html`,
      );
    }
  }

  return offences;
}

test('the build assembles a publishable _site', (t) => {
  if (build === null) {
    return t.skip(
      haveSite
        ? 'scripts/build.mjs has not landed; checking the _site already on disk'
        : 'scripts/build.mjs has not landed and there is no _site',
    );
  }

  assert.equal(build.error, undefined, `could not run scripts/build.mjs: ${build.error?.message}`);
  assert.equal(
    build.status,
    0,
    `node scripts/build.mjs exited ${build.status}\n${(build.stderr ?? '').trim()}`,
  );
  assert.ok(haveSite, 'scripts/build.mjs ran but produced no _site directory');
  assert.ok(
    existsSync(join(siteDir, 'index.html')),
    '_site has no index.html, so the site root would 404',
  );
});

test('every local path the published HTML references exists in _site', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const { pages, pageRefs } = inspect();
  assert.ok(pages.length > 0, 'no HTML was published at all');

  const offences = missing(pageRefs);
  assert.deepEqual(
    offences,
    [],
    `these load as 404s in production, nowhere else:\n  ${offences.join('\n  ')}`,
  );
});

test('no published reference begins with a slash', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const { pageRefs, manifestRefs, workerRefs } = inspect();

  const offences = [];
  for (const ref of [...pageRefs, ...manifestRefs, ...workerRefs]) {
    const value = localValue(ref.value);
    if (value === null || !value.startsWith('/')) continue;
    const reason = value.startsWith('//')
      ? 'is protocol relative, so it leaves this site entirely'
      : 'resolves against the account root instead of this project site at /sudoku/';
    offences.push(`${show(ref.file)} ${ref.where} "${ref.value}" ${reason}`);
  }

  const advice =
    'Pages serves this repository under /sudoku/, so a leading slash silently loads a different ' +
    'repository. Write it relative, for example "./assets/icon.png":';
  assert.deepEqual(offences, [], `${advice}\n  ${offences.join('\n  ')}`);
});

test('the web app manifest parses and every icon it names ships', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const { manifests, manifestErrors, manifestRefs } = inspect();
  if (manifests.length === 0) return t.skip('no web app manifest in _site yet');

  assert.deepEqual(
    manifestErrors,
    [],
    `the browser drops a manifest it cannot parse:\n  ${manifestErrors.join('\n  ')}`,
  );

  const offences = missing(manifestRefs);
  assert.deepEqual(
    offences,
    [],
    `an icon the manifest names but the site does not ship is an install prompt that never appears:\n  ${offences.join('\n  ')}`,
  );
});

test('the service worker precaches only paths that ship', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const { workers, workerRefs } = inspect();
  if (workers.length === 0) return t.skip('no service worker in _site yet');

  const offences = missing(workerRefs);
  assert.deepEqual(
    offences,
    [],
    `one missing entry rejects the whole cache.addAll, so install fails and nothing is cached:\n  ${offences.join('\n  ')}`,
  );
});

/* The canonical origin, and the only place this site is allowed to write one.
   Social scrapers fetch og:image and og:url out of context, so those cannot be
   relative, which also means every check above skips them: localValue() drops
   anything carrying a scheme, so a typo in one of these four paths ships green
   and every preview 404s forever, since a scraper caches the failure. Checked
   by stripping the origin back off and asking the published tree the same
   question the relative sweep asks of everything else. */
const CANONICAL = 'https://diegovalenzuelaiturra.github.io/sudoku/';

test('the absolute social URLs point at files this site publishes', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const page = join(siteDir, 'index.html');
  const source = readFileSync(page, 'utf8');

  const declared = new Map();
  for (const { name: tag, attrs } of startTags(source)) {
    if (tag === 'meta' && attrs.has('content')) {
      const key = attrs.get('property') ?? attrs.get('name');
      if (key !== undefined && !declared.has(key)) declared.set(key, attrs.get('content'));
    }
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u);
    if (tag === 'link' && rel.includes('canonical') && !declared.has('canonical')) {
      declared.set('canonical', attrs.get('href') ?? '');
    }
  }

  const offences = [];
  for (const key of ['og:url', 'canonical', 'og:image', 'twitter:image']) {
    const value = declared.get(key);
    if (value === undefined) {
      offences.push(`${key} is not declared at all`);
      continue;
    }
    if (!value.startsWith(CANONICAL)) {
      offences.push(`${key} "${value}" is not under ${CANONICAL}`);
      continue;
    }
    /* The bare canonical URL is the site root, which Pages serves from
       index.html. Everything else has to be a published file. */
    const tail = value.slice(CANONICAL.length);
    const target = tail === '' ? join(siteDir, 'index.html') : join(siteDir, tail);
    if (!existsExactCase(target)) {
      const wanted = `_site/${tail || 'index.html'}`;
      offences.push(`${key} "${value}" wants ${wanted}, which is not published`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    `a scraper caches what it fetches, including a 404:\n  ${offences.join('\n  ')}`,
  );
});

/* tests/assets.test.mjs asks the same two questions of the repository, which is
   the wrong artifact for both: the minifier rewrites index.html and substitutes
   sw.js on the way into _site, so a source file can satisfy them while the
   bytes a visitor receives do not. */

test('the published page still carries the Apache-2.0 sprite attribution', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const published = readFileSync(join(siteDir, 'index.html'), 'utf8');

  /* removeComments strips HTML comments, and the notice for the inlined
     Material Symbols sprite is one. NOTICE is repository metadata and is not
     published, so this comment is the only attribution that reaches a
     visitor. */
  assert.match(
    published,
    /Material Symbols[\s\S]{0,200}Apache/u,
    '_site/index.html ships the Apache-2.0 icon sprite with no attribution, which the ' +
      'licence requires to travel with the work. Add the comment to ' +
      'HTML_MINIFY_OPTIONS.ignoreCustomComments in scripts/build.mjs.',
  );
});

test('the published service worker carries a substituted cache name', (t) => {
  if (!checkable) return t.skip(SKIPPED);
  const worker = join(siteDir, 'sw.js');
  if (!existsSync(worker)) return t.skip('no service worker in _site yet');
  const published = readFileSync(worker, 'utf8');

  /* Both literals are written out here rather than imported from
     scripts/build.mjs on purpose. The failure this catches is the build and
     the worker disagreeing about the placeholder, and a check that asks the
     build what it substitutes cannot see that: it would substitute nothing,
     report zero, and pass. A cache name frozen at a constant pins every
     returning visitor to the copy they already have. */
  assert.doesNotMatch(
    published,
    /__BUILD__/u,
    '_site/sw.js still holds the build placeholder, so every deploy reuses one cache name',
  );
  assert.match(
    published,
    /"sudoku-[A-Za-z0-9][A-Za-z0-9._-]*"|'sudoku-[A-Za-z0-9][A-Za-z0-9._-]*'/u,
    '_site/sw.js has no build-stamped cache name',
  );
});

test('nothing private leaked into _site', (t) => {
  if (!checkable) return t.skip(SKIPPED);

  const offences = [];
  for (const file of walk(siteDir)) {
    const parts = relative(siteDir, file).split(sep);
    const leaked = parts.find((part) => PRIVATE.has(part));
    const path = `_site/${parts.join('/')}`;
    if (leaked !== undefined) offences.push(`${path} ships "${leaked}"`);
    else if (/\.test\.[cm]?js$/u.test(parts.at(-1))) offences.push(`${path} is a test file`);
  }

  assert.deepEqual(
    offences,
    [],
    `_site is published verbatim, so everything in it is served to the public:\n  ${offences.join('\n  ')}`,
  );
});
