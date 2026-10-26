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

test('every job that sets up node installs the same pinned npm', () => {
  const dir = join(root, '.github', 'workflows');
  const pins = [];
  let setups = 0;

  for (const name of readdirSync(dir)) {
    const yaml = readFileSync(join(dir, name), 'utf8');
    setups += [...yaml.matchAll(/^\s*- uses: actions\/setup-node@/gmu)].length;
    for (const [, version, integrity] of yaml.matchAll(
      /- name: Install npm\s*\n\s*env:\s*\n\s*NPM_VERSION: (\S+)\s*\n\s*NPM_INTEGRITY: (\S+)/gu,
    )) {
      pins.push({ name, version, integrity });
    }
  }

  assert.ok(setups > 0, 'no actions/setup-node step found in .github/workflows');
  assert.equal(
    pins.length,
    setups,
    `${setups} setup-node steps but ${pins.length} "Install npm" steps: a job that sets up node ` +
      'without the pin runs the npm node ships instead.',
  );
  assert.equal(
    new Set(pins.map((p) => `${p.version} ${p.integrity}`)).size,
    1,
    `the npm pins disagree: ${pins.map((p) => `${p.name} ${p.version}`).join(', ')}. ` +
      'Move NPM_VERSION and NPM_INTEGRITY together in every workflow.',
  );
});
