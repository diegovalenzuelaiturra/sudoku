import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, relative } from 'node:path';

import { ESLint } from 'eslint';

import playwrightConfig from '../playwright.config.mjs';
import { ALLOWLIST, build } from '../scripts/build.mjs';

const root = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const WORKFLOWS = '.github/workflows';
const workflowFiles = () =>
  readdirSync(join(root, WORKFLOWS))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => ({ name, yaml: read(`${WORKFLOWS}/${name}`) }));

const jobsOf = (yaml) => {
  const start = yaml.search(/^jobs:\n/mu);
  if (start === -1) return [];
  const body = yaml.slice(start + 'jobs:\n'.length);
  return [...body.matchAll(/^ {2}([\w-]+):\n([\s\S]*?)(?=^ {2}[\w-]+:\n|^\S|$(?![\s\S]))/gmu)].map(
    ([, id, text]) => {
      const name = /^ {4}name: *["']?([^"'\n]+?)["']? *$/mu.exec(text)?.[1];
      return { id, context: name ?? id, text };
    },
  );
};

const stepsOf = (jobText) =>
  jobText
    .split(/^(?= {6}- )/mu)
    .slice(1)
    .map((text) => ({
      text,
      name: /^ {6}(?:- | {2})name: *(.+?) *$/mu.exec(text)?.[1],
      gated: /^ {6}(?:- | {2})if:/mu.test(text),
    }));

const git = (args, input) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', input });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout;
};

test('every codeql-action step runs one commit, so init, analyze and upload-sarif move together', () => {
  const pins = workflowFiles().flatMap(({ name, yaml }) =>
    [...yaml.matchAll(/uses:\s*github\/codeql-action\/([\w-]+)@(\S+)/gu)].map(([, part, sha]) => ({
      where: `${name} ${part}`,
      sha,
    })),
  );

  assert.ok(
    pins.length >= 2,
    'found fewer than two codeql-action steps, so this check is reading the wrong files',
  );
  for (const { where, sha } of pins) {
    assert.match(sha, /^[\da-f]{40}$/u, `${where} names codeql-action by ${sha}, not a commit SHA`);
  }
  assert.deepEqual(
    [...new Set(pins.map(({ sha }) => sha))],
    [pins[0].sha],
    'codeql-action is pinned to more than one commit: ' +
      `${pins.map(({ where, sha }) => `${where}@${sha.slice(0, 12)}`).join(', ')}. ` +
      'The analysis and the SARIF upload then run different releases of one action.',
  );
});

test('only ci.yml publishes a Test or a Lint check, the two contexts the rulesets require by name', () => {
  const contexts = workflowFiles().flatMap(({ name, yaml }) =>
    jobsOf(yaml).map(({ context }) => ({ file: name, context })),
  );

  for (const required of ['Test', 'Lint']) {
    const owners = contexts.filter(
      ({ context }) => context.toLowerCase() === required.toLowerCase(),
    );
    assert.deepEqual(
      owners,
      [{ file: 'ci.yml', context: required }],
      `the required check "${required}" is published by ${JSON.stringify(owners)}. ` +
        'A second job with that name can satisfy or shadow the ruleset, and a renamed one ' +
        'leaves every pull request waiting on a check that never reports.',
    );
  }
});

const verifySteps = () => {
  const job = jobsOf(read(`${WORKFLOWS}/deploy-pages.yml`)).find(({ id }) => id === 'verify');
  assert.ok(job, 'deploy-pages.yml has no verify job');
  return stepsOf(job.text);
};

test('nothing the Pages artifact is built from runs once a check in Verify has failed', () => {
  const steps = verifySteps();
  const artifact = steps.findIndex(({ name }) => name === 'Build the artifact');
  const upload = steps.findIndex(({ text }) =>
    /uses:\s*actions\/upload-pages-artifact@/u.test(text),
  );

  assert.ok(artifact !== -1, 'Verify has no "Build the artifact" step');
  assert.ok(upload > artifact, 'Verify uploads the Pages artifact before it builds it');
  assert.ok(
    steps.slice(0, artifact).some(({ text }) => /!cancelled\(\)/u.test(text)),
    'no step before the artifact build runs on !cancelled(), so this check cannot tell a gated step',
  );
  for (const step of steps.slice(artifact, upload + 1)) {
    assert.equal(
      step.gated,
      false,
      `"${step.name ?? step.text.trim().split('\n')[0]}" carries an if:. Every step from the ` +
        'artifact build to the upload has to keep the implicit success(), or an artifact is ' +
        'produced after a failed check that no step vouched for.',
    );
  }
});

test('the artifact is rebuilt with the commit SHA after the browser suite, which rebuilds without it', () => {
  const steps = verifySteps();
  const index = (name) => steps.findIndex((step) => step.name === name);
  const artifact = index('Build the artifact');
  const browsers = index('Run Playwright tests');

  assert.ok(browsers !== -1, 'Verify has no "Run Playwright tests" step');
  assert.ok(
    artifact > browsers,
    'the artifact build runs before the browser suite, so the published service worker carries ' +
      'the fallback content hash the Playwright fixture leaves behind instead of the commit SHA',
  );
  assert.ok(
    steps.slice(artifact + 1).every(({ text }) => !/npm (?:test|run (?:test|build))\b/u.test(text)),
    'a step after the artifact build rebuilds or retests _site, so the uploaded tree is not the SHA build',
  );
  assert.equal(
    steps[artifact + 1]?.name,
    'List the published files',
    'the published file list is no longer taken straight after the artifact build',
  );
  assert.match(
    steps[artifact].text,
    /BUILD_ID: \$\{\{ github\.sha \}\}/u,
    'the artifact build does not set BUILD_ID to the commit SHA',
  );
  assert.match(
    playwrightConfig.webServer.command,
    /scripts\/build\.mjs/u,
    'the Playwright server no longer rebuilds _site, so the reason for the second build is gone',
  );
});

test('Lighthouse runs one exact release, so a metric cannot change under the budget unannounced', () => {
  const pins = workflowFiles().flatMap(({ yaml }) =>
    [...yaml.matchAll(/\blighthouse@(\S+)/gu)].map(([, version]) => version),
  );

  assert.ok(pins.length > 0, 'no workflow runs lighthouse@<version>');
  for (const version of pins) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/u,
      `lighthouse@${version} is not one exact release, so the budget in ` +
        'scripts/check-budget.mjs can be judged by a Lighthouse it was never measured against',
    );
  }
});

test('no job runs on a moving -latest runner label', () => {
  const labels = workflowFiles().flatMap(({ name, yaml }) =>
    [...yaml.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gmu)].map(([, label]) => ({ name, label })),
  );

  assert.ok(labels.length > 0, 'no runs-on found under .github/workflows');
  for (const { name, label } of labels) {
    assert.doesNotMatch(
      label,
      /-latest\b/u,
      `${name} runs on ${label}, a label GitHub migrates to a new image on its own schedule, ` +
        'so the runner would change without a commit',
    );
  }
});

test('the Lint job skips the two hooks it must, as separate flags that name real hooks', () => {
  const lint = jobsOf(read(`${WORKFLOWS}/ci.yml`)).find(({ context }) => context === 'Lint');
  assert.ok(lint, 'ci.yml has no Lint job');
  const line = /run:\s*(npm run lint\b.*)$/mu.exec(lint.text)?.[1];
  assert.ok(line, 'the Lint job no longer runs npm run lint');

  const skips = [...line.matchAll(/--skip[ =](\S+)/gu)].map(([, id]) => id);
  for (const skip of skips) {
    assert.doesNotMatch(
      skip,
      /,/u,
      `"--skip ${skip}" is a comma list, which prek reads as one hook name that matches nothing, ` +
        'and then runs every hook in it',
    );
  }
  const hooks = new Set(
    [...read('.pre-commit-config.yaml').matchAll(/^\s*- id:\s*(\S+)/gmu)].map(([, id]) => id),
  );
  for (const [hook, why] of [
    ['no-commit-to-branch', 'it fails on a push to main or a dispatch, where HEAD is a branch'],
    ['unit-tests-coverage', 'the Test job already runs it'],
  ]) {
    assert.ok(skips.includes(hook), `the Lint job does not skip ${hook}, and ${why}`);
    assert.ok(hooks.has(hook), `.pre-commit-config.yaml has no hook ${hook}, so the skip is inert`);
  }
});

test('every Dependabot ecosystem proposes against development, never main', () => {
  const entries = read('.github/dependabot.yml')
    .split(/^\s*- package-ecosystem:/mu)
    .slice(1);

  assert.ok(entries.length >= 3, 'found fewer Dependabot ecosystems than this repository declares');
  for (const entry of entries) {
    const ecosystem = entry.trim().split('\n')[0];
    assert.match(
      entry,
      /^\s*target-branch:\s*development\s*$/mu,
      `the ${ecosystem} entry does not target development, so its bumps would reach the ` +
        'published branch without passing through the one every other change is staged on',
    );
  }
});

const pageScripts = () =>
  [...read('index.html').matchAll(/<script\s+src="([^"]+)"/gu)].map(([, src]) => src);

const copyPublishedTree = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sudoku-constraints-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of [...ALLOWLIST.map((entry) => entry.path), ...pageScripts()]) {
    if (existsSync(join(root, path)))
      cpSync(join(root, path), join(dir, path), { recursive: true });
  }
  return dir;
};

let outputs = 0;
const contentBuild = (dir) => {
  outputs += 1;
  const outDir = join(dir, `_out${outputs}`);
  const result = build({ root: dir, outDir, buildId: '' });
  assert.equal(result.idSource, 'content hash');
  return { id: result.buildId, page: readFileSync(join(outDir, 'index.html'), 'utf8') };
};

test('the content hash build id is the same for the same tree, wherever and whenever it is built', (t) => {
  const dir = copyPublishedTree(t);
  const first = contentBuild(dir);
  const second = contentBuild(dir);

  assert.equal(
    second.id,
    first.id,
    'two builds of one tree produced different build ids, so every deploy would empty every ' +
      "returning visitor's service worker cache",
  );
});

test('changing any script the page loads changes the build id, so returning visitors get the new game', (t) => {
  const scripts = pageScripts();
  assert.ok(
    scripts.includes('app.js'),
    'index.html no longer loads app.js, so this reads the wrong page',
  );

  for (const src of scripts) {
    const dir = copyPublishedTree(t);
    const before = contentBuild(dir);
    writeFileSync(join(dir, src), `${readFileSync(join(dir, src), 'utf8')}\n;void 0;\n`);
    const after = contentBuild(dir);

    assert.notEqual(after.page, before.page, `a change to ${src} did not reach the published page`);
    assert.notEqual(
      after.id,
      before.id,
      `a change to ${src} kept the build id, so the service worker keeps serving the cached ` +
        'previous version to every returning visitor',
    );
  }
});

const editorconfigSections = (file) => {
  const sections = [];
  for (const line of read(file).split('\n')) {
    const header = /^\[(.+)\]$/u.exec(line.trim());
    if (header) sections.push({ glob: header[1], keys: {} });
    const pair = /^\s*([\w-]+)\s*=\s*(\S+)\s*$/u.exec(line);
    if (pair && sections.length > 0) sections.at(-1).keys[pair[1]] = pair[2];
  }
  return sections;
};

test('the editor, Biome and ESLint agree that HTML indents four', async () => {
  const sections = editorconfigSections('.editorconfig');
  const editor =
    sections.findLast(({ glob, keys }) => glob === '*.html' && keys.indent_size)?.keys
      .indent_size ?? sections.find(({ glob }) => glob === '*')?.keys.indent_size;

  const biome = JSON.parse(read('biome.json'));
  const biomeWidth = biome.html?.formatter?.indentWidth ?? biome.formatter?.indentWidth;

  const eslint = await new ESLint({ cwd: root }).calculateConfigForFile('index.html');
  const eslintWidth = eslint.rules?.['html/indent']?.[1];

  assert.deepEqual(
    { editorconfig: Number(editor), biome: biomeWidth, eslint: eslintWidth },
    { editorconfig: 4, biome: 4, eslint: 4 },
    'the HTML indent width disagrees between .editorconfig, biome.json and the html/indent rule, ' +
      'so an editor and a linter take turns rewriting index.html',
  );
});

test('the editor and git both write LF into every text file', () => {
  const sections = editorconfigSections('.editorconfig');
  assert.equal(
    sections.find(({ glob }) => glob === '*')?.keys.end_of_line,
    'lf',
    '.editorconfig no longer sets end_of_line = lf for every file',
  );
  for (const { glob, keys } of sections) {
    if (keys.end_of_line === undefined) continue;
    assert.ok(
      ['lf', 'unset'].includes(keys.end_of_line),
      `.editorconfig [${glob}] sets end_of_line = ${keys.end_of_line}, which git rewrites back to LF`,
    );
  }

  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  assert.ok(files.includes('index.html'), 'git ls-files did not list index.html');
  const attrs = git(['check-attr', '-z', '--stdin', 'text', 'eol'], files.join('\0')).split('\0');
  const byFile = new Map();
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    byFile.set(attrs[i], { ...byFile.get(attrs[i]), [attrs[i + 1]]: attrs[i + 2] });
  }

  for (const [file, { text, eol }] of byFile) {
    if (text === 'unset') continue;
    assert.equal(
      eol,
      'lf',
      `git checks ${file} out with eol=${eol} while .editorconfig writes LF, and the two ` +
        'disagreeing is worse than having neither',
    );
  }
});

test('no diff driver is set on JavaScript or JSON, where git has none and the rule is inert', () => {
  const files = git(['ls-files', '-z'])
    .split('\0')
    .filter((file) => /\.(?:m?js|json)$/u.test(file));
  assert.ok(files.length > 0, 'no tracked JavaScript or JSON file found');

  const attrs = git(['check-attr', '-z', '--stdin', 'diff'], files.join('\0')).split('\0');
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    assert.equal(
      attrs[i + 2],
      'unspecified',
      `${attrs[i]} has diff=${attrs[i + 2]}. Git ships no JavaScript or JSON driver and its ` +
        'default heuristic already names the enclosing function, so the rule is inert or worse',
    );
  }
});

test('the browser suite never reuses a server, so it cannot test another worktree build', () => {
  const servers = [playwrightConfig.webServer].flat();
  assert.ok(servers.length > 0, 'playwright.config.mjs starts no web server');
  for (const server of servers) {
    assert.equal(
      server.reuseExistingServer,
      false,
      'reuseExistingServer is not false, so whatever already holds the port is tested and ' +
        'reported green in place of this checkout',
    );
  }
});

test('Playwright writes its artifacts inside node_modules, which the typography scan skips', () => {
  const where = normalize(relative(root, join(root, playwrightConfig.outputDir)));
  assert.match(
    where,
    /^node_modules[\\/]/u,
    `Playwright writes traces to ${where}, where the typography scan reads binary zips as text ` +
      'and fails on a banned character decoded by chance',
  );
});

const PLATFORM_RULES = {
  'unicorn/consistent-function-scoping': [
    'function outer() {\n  function inner() {\n    return 1;\n  }\n  return inner();\n}\nouter();\n',
    'it hoists functions out of page.evaluate callbacks, which run serialised in the browser',
  ],
  'unicorn/require-post-message-target-origin': [
    'window.postMessage("x");\n',
    'a worker postMessage has no target origin to give',
  ],
  'unicorn/no-array-reverse': [
    'export const last = [1, 2].slice().reverse();\n',
    'its fix is toReversed, which Safari only has from 16.4 and the floor is 15.4',
  ],
  'eslint/no-unmodified-loop-condition': [
    'export function run() {\n  let left = 3;\n  const tick = () => {\n    left -= 1;\n  };\n' +
      '  while (left > 0) {\n    tick();\n  }\n}\n',
    'the generator search decrements its loop counter in a helper the rule cannot see through',
  ],
};

const oxlintFires = (t, rules) => {
  const dir = mkdtempSync(join(tmpdir(), 'sudoku-oxlint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(read('.oxlintrc.json'));
  delete config.$schema;
  config.categories = Object.fromEntries(
    ['correctness', 'suspicious', 'pedantic', 'perf', 'style', 'restriction'].map((c) => [
      c,
      'error',
    ]),
  );
  config.rules = rules(config.rules);
  writeFileSync(join(dir, 'oxlintrc.json'), JSON.stringify(config));
  for (const [rule, [code]] of Object.entries(PLATFORM_RULES)) {
    writeFileSync(join(dir, `${rule.replace('/', '-')}.js`), code);
  }

  const run = spawnSync(
    join(root, 'node_modules', '.bin', 'oxlint'),
    ['-c', 'oxlintrc.json', '--format', 'unix', '.'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(run.error, undefined, `oxlint did not run: ${run.error}`);
  return Object.keys(PLATFORM_RULES).filter((rule) =>
    run.stdout.includes(`(${rule.split('/')[1]})`),
  );
};

test('the four rules that are wrong here stay off when every oxlint category is switched on', (t) => {
  const own = JSON.parse(read('.oxlintrc.json')).rules ?? {};
  const fired = oxlintFires(t, (rules) => rules);

  for (const [rule, [, why]] of Object.entries(PLATFORM_RULES)) {
    assert.equal(own[rule], 'off', `.oxlintrc.json does not switch ${rule} off, and ${why}`);
    assert.ok(!fired.includes(rule), `${rule} fires once every category is on, and ${why}`);
  }
});

test('each of those four rules fires on its sample when the config does not switch it off', (t) => {
  const fired = oxlintFires(t, (rules) =>
    Object.fromEntries(Object.entries(rules).filter(([rule]) => !(rule in PLATFORM_RULES))),
  );

  assert.deepEqual(
    fired,
    Object.keys(PLATFORM_RULES),
    'a sample no longer trips its rule, so the check above would pass whether or not the rule is off',
  );
});
