/* Four invariants that hold today, that nothing enforced, and that a single
   careless install or workflow edit can flip without touching a line of source.

   OSV-Scanner answers a different question. It asks whether a package this tree
   depends on has a published advisory, and it is the right tool for that. It
   does not ask where the bytes come from, and a lockfile that fetches one
   package from somebody's server is not a vulnerability that has been
   published, it is a vulnerability that has been installed. lockfile-lint is
   the usual answer; this is the same check written in the shape this repository
   already uses, which costs no dependency and runs in the suite that is already
   required to pass. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/* The root entry describes this repository, which is not fetched from
   anywhere, so it carries neither a resolved URL nor an integrity hash. Every
   other entry is something downloaded onto a machine that then runs it. */
const fetched = Object.entries(lock.packages).filter(([name]) => name !== '');

const REGISTRY = 'https://registry.npmjs.org/';

test('every package in the lockfile is fetched from the public npm registry', () => {
  const strays = fetched
    .filter(([, entry]) => entry.resolved !== undefined && !entry.resolved.startsWith(REGISTRY))
    .map(([name, entry]) => `${name} <- ${entry.resolved}`);

  assert.deepEqual(
    strays,
    [],
    'package-lock.json resolves packages somewhere other than the public registry. A lockfile ' +
      'is the one place a substituted host survives review, because the version numbers in the ' +
      'diff all look right.',
  );
});

test('every package in the lockfile carries an integrity hash', () => {
  /* Without one, npm has nothing to compare the download against, so a tarball
     swapped at the registry or in a proxy installs silently. */
  const unhashed = fetched
    .filter(([, entry]) => entry.resolved !== undefined && entry.integrity === undefined)
    .map(([name]) => name);

  assert.deepEqual(
    unhashed,
    [],
    'package-lock.json has an entry with a resolved URL and no integrity hash, so npm will ' +
      'install whatever that URL serves',
  );
});

test('nothing is declared by git, file or plain http', () => {
  /* A git or tarball dependency is a moving target that no advisory database
     indexes and no integrity hash pins. There are none here, and the point of
     the test is that adding one has to be deliberate. */
  const declared = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  });

  const offences = declared
    .filter(([, range]) => /^(git|git\+|https?:|file:|github:|[\w-]+\/[\w-]+$)/u.test(range))
    .map(([name, range]) => `${name}: ${range}`);

  assert.deepEqual(
    offences,
    [],
    'package.json declares a dependency by URL, path or repository shorthand rather than by ' +
      'version range',
  );
});

test('every npm ci in the workflows refuses lifecycle scripts', () => {
  /* An install script is arbitrary code from a stranger, run on a runner that
     holds this repository's token, before any test has looked at anything.
     --ignore-scripts is what stops that, and it was verified that the suite
     passes without them. tests/build.test.mjs already asserts that a job which
     builds also installs; this asserts how. */
  const dir = join(root, '.github', 'workflows');
  const offences = [];

  for (const name of readdirSync(dir)) {
    const yaml = readFileSync(join(dir, name), 'utf8');
    for (const [line] of yaml.matchAll(/^\s*run:\s*npm ci.*$/gmu)) {
      if (!line.includes('--ignore-scripts')) offences.push(`${name}: ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offences,
    [],
    'a workflow runs npm ci without --ignore-scripts, so a dependency lifecycle script executes ' +
      'on the runner before anything checks it',
  );
});
