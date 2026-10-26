import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

const read = (path) => readFileSync(join(root, path), 'utf8');

const hookRev = (config) => {
  const block =
    /-\s*repo:\s*https:\/\/github\.com\/zizmorcore\/zizmor-pre-commit\s*\n\s*rev:\s*v([\d.]+)/u;
  const found = config.match(block);
  assert.ok(found, 'no zizmor-pre-commit repo with a rev in .pre-commit-config.yaml');
  return found[1];
};

const workflowVersion = (workflow) => {
  const input =
    /uses:\s*zizmorcore\/zizmor-action@[\da-f]{40}[^\n]*\n\s*with:\s*\n\s*version:\s*"([\d.]+)"/u;
  const found = workflow.match(input);
  assert.ok(found, 'no zizmor-action step with a version input in zizmor.yml');
  return found[1];
};

test('the zizmor the workflow runs is the one the hook pins', () => {
  const rev = hookRev(read('.pre-commit-config.yaml'));
  const version = workflowVersion(read('.github/workflows/zizmor.yml'));

  assert.equal(
    version,
    rev,
    `zizmor.yml runs ${version} and .pre-commit-config.yaml pins v${rev}. ` +
      'Move both or neither: the hook and the required check have to agree.',
  );
});

test('both zizmor versions are still readable where this suite looks for them', () => {
  assert.match(read('.pre-commit-config.yaml'), /zizmorcore\/zizmor-pre-commit/u);
  assert.match(read('.github/workflows/zizmor.yml'), /zizmorcore\/zizmor-action@[\da-f]{40}/u);
});

const gating = {
  CodeQL: '.github/workflows/codeql.yml',
  zizmor: '.github/workflows/zizmor.yml',
  'osv-scanner': '.github/workflows/osv-scanner.yml',
};

const pullRequestBlock = (workflow, file) => {
  const found = workflow.match(/\n {2}pull_request:[^\n]*\n((?: {4,}[^\n]*\n)*)/u);
  assert.ok(found, `${file} has no pull_request trigger, so it cannot report on one`);
  return found[1];
};

for (const [tool, file] of Object.entries(gating)) {
  test(`${tool} runs on every pull request, because the merge rule waits for it`, () => {
    assert.doesNotMatch(
      pullRequestBlock(read(file), file),
      /paths:/u,
      `${file} filters which pull requests it runs on, and the code scanning rule ` +
        `names ${tool}. Every pull request the filter skips waits for an analysis ` +
        'that never arrives.',
    );
  });
}

for (const [tool, file] of Object.entries(gating)) {
  test(`${tool} runs on a push to main, so a release merge commit has results`, () => {
    assert.match(
      read(file),
      /\n {2}push:\n {4}branches: \[main\]/u,
      `${file} does not run on a push to main, and the code scanning rule names ${tool}. ` +
        'The fast forward after a release waits for results that commit never gets.',
    );
  });
}

test('every osv-scanner call keeps its exit code, so a finding reaches the upload', () => {
  const calls = read('.github/workflows/osv-scanner.yml')
    .split('\n')
    .filter((line) => /^\s*\.\/osv-scanner scan\b/u.test(line));

  assert.ok(calls.length > 0, 'no ./osv-scanner scan call in osv-scanner.yml');
  for (const call of calls) {
    assert.match(
      call,
      /\|\| code=\$\?$/u,
      `"${call.trim()}" lets -e end the step on a finding, so no analysis is published ` +
        'and the code scanning rule waits for one forever.',
    );
  }
});

test('the merge workflow names every tool that gates it', () => {
  const workflow = read('.github/workflows/dependabot-auto-merge.yml');

  for (const tool of Object.keys(gating)) {
    assert.ok(
      workflow.includes(tool),
      `dependabot-auto-merge.yml does not mention ${tool}, which gates the merge it queues.`,
    );
  }
});

const NPM_ACTION = '.github/actions/install-npm/action.yml';
const SETUP_NODE = /^[ \t]*- uses: actions\/setup-node@/gmu;
const INSTALL_NPM = /^[ \t]*(?:- )?uses: \.\/\.github\/actions\/install-npm[ \t]*$/gmu;

test('every job that sets up node installs the pinned npm right after', () => {
  const dir = join(root, '.github', 'workflows');
  let setups = 0;

  for (const name of readdirSync(dir)) {
    const yaml = readFileSync(join(dir, name), 'utf8');
    const kinds = [
      ...[...yaml.matchAll(SETUP_NODE)].map(({ index }) => ({ index, kind: 'setup-node' })),
      ...[...yaml.matchAll(INSTALL_NPM)].map(({ index }) => ({ index, kind: 'install-npm' })),
    ]
      .toSorted((a, b) => a.index - b.index)
      .map(({ kind }) => kind);
    const nodeSetups = kinds.filter((kind) => kind === 'setup-node').length;

    assert.deepEqual(
      kinds,
      Array.from({ length: nodeSetups }, () => ['setup-node', 'install-npm']).flat(),
      `${name} does not follow each setup-node step with one call of ./.github/actions/install-npm: ` +
        'a job that sets up node without the pinned npm runs the npm node ships instead.',
    );
    assert.doesNotMatch(
      yaml,
      /NPM_VERSION|NPM_INTEGRITY/u,
      `${name} pins npm itself, and the one pin lives in ${NPM_ACTION}, so two copies would drift.`,
    );
    setups += nodeSetups;
  }

  assert.ok(setups > 0, 'no actions/setup-node step found in .github/workflows');
});

test('the npm pin is written once, as a version and its registry integrity', () => {
  const action = read(NPM_ACTION);
  const versions = [...action.matchAll(/^[ \t]*NPM_VERSION: (\S+)[ \t]*$/gmu)].map(
    ([, value]) => value,
  );
  const integrities = [...action.matchAll(/^[ \t]*NPM_INTEGRITY: (\S+)[ \t]*$/gmu)].map(
    ([, value]) => value,
  );

  assert.match(
    action,
    /^[ \t]*using: composite[ \t]*$/mu,
    `${NPM_ACTION} is no longer a composite action`,
  );
  assert.equal(versions.length, 1, `${NPM_ACTION} sets NPM_VERSION ${versions.length} times`);
  assert.match(
    versions[0],
    /^\d+\.\d+\.\d+$/u,
    `NPM_VERSION ${versions[0]} is not one exact release, so the integrity beside it cannot describe it`,
  );
  assert.equal(
    integrities.length,
    1,
    `${NPM_ACTION} sets NPM_INTEGRITY ${integrities.length} times`,
  );
  assert.match(
    integrities[0],
    /^sha512-[A-Za-z0-9+/]{86}==$/u,
    'NPM_INTEGRITY is not a sha512 integrity as the registry publishes it, the only form the step ' +
      'computes from the tarball to compare against',
  );
});
