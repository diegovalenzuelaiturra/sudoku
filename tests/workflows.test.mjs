/* The Zizmor audit runs twice over the same workflows, once as a git hook and
   once as a required check, and the two have to be the same build of the tool
   or the hook passes a file the check then rejects. This test is what joins
   them. A comment asserting the two agree is not a mechanism, and the drift it
   was meant to prevent survived three merges unseen. Dependabot cannot close
   the gap either, since the workflow carries the version as a plain string
   rather than as an action reference. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

const read = (path) => readFileSync(join(root, path), 'utf8');

/* Matched with a regular expression rather than a YAML parser. This repository
   ships no runtime dependencies and has no parser among its dev ones, and the
   two values wanted here are a tag and a quoted string on lines that a pattern
   reads as reliably as a tree walk would. */
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

/* The action refuses a version its own table has no digest for, so a bump to
   the hook alone can turn the workflow red at run time rather than here. The
   pattern above is what keeps that failure in the unit suite, where it costs
   seconds. This asserts the pattern still matches something, so a rename
   upstream fails loudly instead of quietly matching nothing. */
test('both zizmor versions are still readable where this suite looks for them', () => {
  assert.match(read('.pre-commit-config.yaml'), /zizmorcore\/zizmor-pre-commit/u);
  assert.match(read('.github/workflows/zizmor.yml'), /zizmorcore\/zizmor-action@[\da-f]{40}/u);
});

/* The code scanning rule in both rulesets blocks a merge that has no results
   from a tool it names, as well as one with alerts. A path filter on the
   workflow that publishes such a tool therefore wedges every pull request the
   filter skips, with no bypass actor to undo it. The rule itself lives in
   GitHub's settings where nothing in this tree can read it, so what is
   mechanised here is the half that does live in the tree. */
const gating = {
  CodeQL: '.github/workflows/codeql.yml',
  zizmor: '.github/workflows/zizmor.yml',
  'osv-scanner': '.github/workflows/osv-scanner.yml',
};

/* The lines indented under the pull_request key, which is the only place a
   paths filter can sit. A comment or the next trigger sits at two spaces and
   ends the block, so an empty capture is the shape wanted here. */
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

/* The merge job's header tells a reader which tools decide when a bump lands.
   A tool added to the rule and not to that list leaves the file describing a
   gate it no longer has. */
test('the merge workflow names every tool that gates it', () => {
  const workflow = read('.github/workflows/dependabot-auto-merge.yml');

  for (const tool of Object.keys(gating)) {
    assert.ok(
      workflow.includes(tool),
      `dependabot-auto-merge.yml does not mention ${tool}, which gates the merge it queues.`,
    );
  }
});
