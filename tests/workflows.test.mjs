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
