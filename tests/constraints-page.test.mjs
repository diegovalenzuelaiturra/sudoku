import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import html from '@html-eslint/eslint-plugin';
import { Linter } from 'eslint';
import fc from 'fast-check';
import globals from 'globals';
import { ALLOWLIST, build, minifySite } from '../scripts/build.mjs';

const root = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const require = createRequire(import.meta.url);

require(join(root, 'stats.js'));
const S = globalThis.SudokuStats;
delete globalThis.SudokuStats;

const BUILD_ID = 'constraintcheck1';
const PUZZLE_REQUEST = { clues: 40, grade: 1, seed: 1 };

let site;
test.before(async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'sudoku-constraints-'));
  const result = build({ root, outDir, buildId: BUILD_ID });
  await minifySite({ outDir, files: result.files.filter((file) => file.path.endsWith('.js')) });
  site = { outDir, read: (rel) => readFileSync(join(outDir, rel), 'utf8') };
});
test.after(() => site && rmSync(site.outDir, { recursive: true, force: true }));

const isSyntaxError = (error) => error?.name === 'SyntaxError';

function runServiceWorker(source, cacheNames) {
  const listeners = {};
  const opened = [];
  const precached = [];
  const deleted = [];
  const cache = {
    addAll: async (list) => {
      precached.push(...list);
    },
    match: async () => undefined,
  };
  const context = {
    caches: {
      open: async (name) => {
        opened.push(name);
        return cache;
      },
      keys: async () => cacheNames,
      delete: async (name) => {
        deleted.push(name);
        return true;
      },
    },
    fetch: () => {
      throw new Error('the service worker reached the network in a test');
    },
  };
  context.self = context;
  context.addEventListener = (type, listener) => {
    listeners[type] = listener;
  };
  context.skipWaiting = () => {};
  context.clients = { claim: async () => {} };
  vm.runInNewContext(source, context);

  const fire = async (type) => {
    const pending = [];
    listeners[type]({ waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  return { fire, opened, precached, deleted };
}

function workerUrl() {
  const app = read('app.js');
  const call = app.match(/new Worker\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/u);
  assert.ok(call, 'app.js no longer constructs a worker, so this check has nothing to read');
  if (call[1]) return call[1];
  const named = app.match(new RegExp(`const ${call[2]} = '([^']+)'`, 'u'));
  assert.ok(named, `could not resolve ${call[2]}, the URL app.js hands to new Worker`);
  return named[1];
}

test('the installed app precaches every script it needs offline, the generator worker first', async () => {
  const sw = runServiceWorker(site.read('sw.js'), []);
  await sw.fire('install');
  const shell = new Set(sw.precached);

  const generator = workerUrl();
  assert.ok(
    shell.has(generator),
    `the service worker never precaches ${generator}, the script app.js runs as a worker: ` +
      'an app installed and then taken offline loads, shows the difficulty picker, and fails on the first tap',
  );

  const expected = ALLOWLIST.filter((entry) => !['404.html', 'sw.js'].includes(entry.path)).flatMap(
    (entry) =>
      entry.type === 'dir'
        ? readdirSync(join(root, entry.path)).map((name) => `./${entry.path}/${name}`)
        : [`./${entry.path}`],
  );
  const missing = expected.filter((url) => !shell.has(url));
  assert.deepEqual(
    missing,
    [],
    'the build publishes these but the service worker never caches them, so the installed app ' +
      `has nothing to serve for them offline:\n  ${missing.join('\n  ')}`,
  );
});

test('the published service worker opens a cache named for this build', async () => {
  const sw = runServiceWorker(site.read('sw.js'), []);
  await sw.fire('install');
  assert.deepEqual(
    sw.opened,
    [`sudoku-${BUILD_ID}`],
    'the install cache is not named for the build, so every deploy would reuse one cache ' +
      'and pin each visitor to the first version they loaded',
  );
});

test("activating a new build deletes only this app's older caches, never another site's", async () => {
  const current = `sudoku-${BUILD_ID}`;
  const sw = runServiceWorker(site.read('sw.js'), [
    'sudoku-old',
    'other-app',
    current,
    'not-sudoku-old',
    'workbox-precache',
  ]);
  await sw.fire('activate');
  assert.deepEqual(
    sw.deleted,
    ['sudoku-old'],
    'activate deleted a cache this app did not open: on a github.io account domain every ' +
      'project page shares one CacheStorage, so that wipes their offline copies',
  );
});

function lint(code, config) {
  return new Linter()
    .verify(code, config)
    .map((m) => `${m.line}:${m.column} ${m.ruleId ?? 'parse'} ${m.message}`);
}

test('generator.js reads nothing a worker lacks and adds no global but SudokuGenerator', () => {
  const problems = lint(read('generator.js'), [
    {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globals.worker },
      rules: {
        'no-undef': 'error',
        'no-implicit-globals': ['error', { lexicalBindings: true }],
      },
    },
  ]);
  assert.deepEqual(
    problems,
    [],
    'generator.js runs as a worker, where document and window do not exist, and as a classic ' +
      `script beside app.js, where any other top level name collides:\n  ${problems.join('\n  ')}`,
  );
});

test('stats.js reads no clock, no random source, no DOM and no storage', () => {
  const problems = lint(read('stats.js'), [
    {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'script',
        globals: { self: 'readonly' },
      },
      rules: {
        'no-undef': 'error',
        'no-implicit-globals': ['error', { lexicalBindings: true }],
        'no-restricted-properties': [
          'error',
          { object: 'Math', property: 'random' },
          { object: 'Date', property: 'now' },
        ],
        'no-restricted-syntax': [
          'error',
          'NewExpression[callee.name="Date"]',
          'CallExpression[callee.name="Date"]',
        ],
      },
    },
  ]);
  assert.deepEqual(
    problems,
    [],
    'stats.js has to be a pure function of the rows handed in, or the same history reads ' +
      `differently from one paint to the next:\n  ${problems.join('\n  ')}`,
  );
});

function workerContext() {
  const listeners = {};
  const posted = [];
  const context = {
    WorkerGlobalScope: class WorkerGlobalScope {},
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    postMessage: (message) => posted.push(message),
  };
  context.self = context;
  return { context, listeners, posted };
}

for (const [label, rel] of [
  ['source', null],
  ['published', 'generator.js'],
]) {
  test(`the ${label} generator answers a puzzle request when run as a worker`, () => {
    const source = rel ? site.read(rel) : read('generator.js');
    const { context, listeners, posted } = workerContext();
    vm.runInNewContext(source, context);

    assert.equal(typeof listeners.message, 'function', 'the worker never listens for a request');
    listeners.message({ data: { id: 7, ...PUZZLE_REQUEST } });
    assert.equal(posted.length, 1, 'the worker did not answer the request');
    assert.equal(
      posted[0].ok,
      true,
      `the worker failed to build a board: ${posted[0].error}. A worker has no document or window`,
    );
    assert.equal(posted[0].id, 7, 'the reply lost the id the page matches it by');
    assert.equal(posted[0].puzzle.length, 81);
  });
}

test('the published generator still works as the classic script fallback beside the page scripts', () => {
  const listeners = [];
  const context = { document: {} };
  context.self = context;
  context.window = context;
  context.addEventListener = (type) => listeners.push(type);
  vm.createContext(context);

  for (const rel of ['stats.js', 'app.js']) {
    try {
      vm.runInContext(read(rel), context, { filename: rel });
    } catch (error) {
      assert.ok(!isSyntaxError(error), `${rel} does not parse: ${error.message}`);
    }
  }
  const before = new Set(Object.keys(context));
  const pageListeners = listeners.length;

  try {
    vm.runInContext(site.read('generator.js'), context, { filename: 'generator.js' });
  } catch (error) {
    assert.fail(
      `the published generator.js threw when injected as a <script> after app.js, so the ` +
        `fallback gives the player no board at all: ${error.name}: ${error.message}`,
    );
  }

  const added = Object.keys(context).filter((key) => !before.has(key));
  assert.deepEqual(
    added,
    ['SudokuGenerator'],
    'the fallback script has to add exactly one global, and minification must leave its name readable',
  );
  assert.equal(
    listeners.length,
    pageListeners,
    'the generator wired up worker messaging on a page, where there is no worker to talk to',
  );

  const fromPage = context.SudokuGenerator.makePuzzle(PUZZLE_REQUEST);
  require(join(root, 'generator.js'));
  const fromSource = globalThis.SudokuGenerator.makePuzzle(PUZZLE_REQUEST);
  delete globalThis.SudokuGenerator;
  assert.deepEqual(
    JSON.parse(JSON.stringify(fromPage)),
    JSON.parse(JSON.stringify(fromSource)),
    'the minified generator builds a different board from the same seed than the source does',
  );
});

const KEYS = ['easy', 'medium', 'hard', 'expert'];
const stored = (t, s) => ({ t, s, m: 0, h: 0, g: 1, d: 'easy' });

test('the progress report never throws, whatever the stored history holds', () => {
  assert.doesNotThrow(() => S.report([]), 'an empty ring threw, which costs the unfinished board');
  const plausible = fc.record({
    t: fc.integer(),
    s: fc.integer({ min: 0, max: S.MAX_SECONDS }),
    m: fc.nat(3),
    h: fc.nat(3),
    g: fc.integer({ min: 0, max: S.MAX_GRADE + 1 }),
    d: fc.constantFrom(...KEYS, 'x'),
  });
  const history = fc.oneof(
    fc.anything(),
    fc.array(fc.anything()),
    fc.array(plausible, { maxLength: 40 }),
    fc.array(fc.oneof(plausible, fc.anything()), { maxLength: 40 }),
  );
  fc.assert(
    fc.property(history, (held) => {
      const view = S.report(S.readRows(held, KEYS));
      for (let g = 1; g <= S.MAX_GRADE; g++) {
        assert.equal(typeof view.grades[g].n, 'number', `grade ${g} is missing from the report`);
      }
    }),
    { numRuns: 300 },
  );
});

test('readRows hands back the history in the order it was stored, whatever the clocks said', () => {
  const rows = S.readRows([stored(300, 30), stored(100, 10), stored(200, 20)], KEYS);
  assert.deepEqual(
    rows.map((row) => row.t),
    [300, 100, 200],
    'readRows reordered the history, and the trend reads the order games were played in',
  );
});

test('a stored row keeps the time the clock gave it, however far it sits from the rest', () => {
  assert.equal(S.readRow(stored(0, 5000), KEYS).s, 5000, 'a long game was trimmed on read');
  assert.equal(S.readRow(stored(0, S.MAX_SECONDS), KEYS).s, S.MAX_SECONDS);

  const history = Array.from({ length: 10 }, (_, i) => stored(i, i === 9 ? 5000 : 400));
  assert.equal(
    S.readRows(history, KEYS)[9].s,
    5000,
    'the trend cap reached the stored row: the row is the record of what happened, the cap is a model of it',
  );
});

test('theme-color is one colour across the page, the error page and the manifest', () => {
  const themeColor = (rel) => read(rel).match(/<meta name="theme-color" content="([^"]+)">/u)?.[1];
  const manifest = JSON.parse(read('manifest.webmanifest')).theme_color;

  for (const [rel, why] of [
    ['index.html', 'the page and the manifest paint the same title bar of the installed app'],
    ['404.html', 'the 404 page sends people back to the game and has to look like it'],
  ]) {
    const colour = themeColor(rel);
    assert.ok(colour, `${rel} lost its theme-color meta, which colours the browser UI around it`);
    assert.equal(
      colour.toLowerCase(),
      manifest.toLowerCase(),
      `${rel} paints the browser UI ${colour} and the manifest says ${manifest}: ${why}`,
    );
  }
});

function cssBlocks(sheet) {
  const blocks = [];
  const open = [];
  let text = '';
  for (const ch of sheet.replace(/\/\*[\s\S]*?\*\//gu, '')) {
    if (ch === '{') {
      open.push(text.trim());
      text = '';
    } else if (ch === '}') {
      blocks.push({
        selectors: open
          .pop()
          .split(',')
          .map((s) => s.trim()),
        body: text,
      });
      text = '';
    } else {
      text += ch;
    }
  }
  return blocks;
}

test('the board declares touch-action itself, not only through body', () => {
  const sheet = [...read('index.html').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)]
    .map((m) => m[1])
    .join('\n');
  const blocks = cssBlocks(sheet);

  for (const selector of ['body', '.board']) {
    assert.ok(
      blocks.some(
        (block) =>
          block.selectors.includes(selector) &&
          /(?:^|;)\s*touch-action\s*:\s*manipulation\s*(?:;|$)/u.test(block.body),
      ),
      `${selector} no longer declares touch-action:manipulation. The board is overflow:hidden, ` +
        'which stops the ancestor walk there, so the 81 cells would lose the double tap fix',
    );
  }
});

test('every live region sits outside .app, which each overlay makes inert', () => {
  const inside = [];
  const seen = [];
  const attr = (node, name) =>
    node.attributes.find((a) => a.key.value.toLowerCase() === name)?.value?.value;
  const plugin = {
    rules: {
      'live-regions-outside-app': {
        create: () => ({
          Tag(node) {
            const role = attr(node, 'role');
            if (attr(node, 'aria-live') === undefined && role !== 'status' && role !== 'alert') {
              return;
            }
            const id = attr(node, 'id') ?? `<${node.name}> at line ${node.loc.start.line}`;
            seen.push(id);
            for (let up = node.parent; up; up = up.parent) {
              if (up.type === 'Tag' && (attr(up, 'class') ?? '').split(/\s+/u).includes('app')) {
                inside.push(id);
                return;
              }
            }
          },
        }),
      },
    },
  };

  const problems = new Linter()
    .verify(
      read('index.html'),
      {
        files: ['**/*.html'],
        plugins: { html, local: plugin },
        language: 'html/html',
        rules: { 'local/live-regions-outside-app': 'error' },
      },
      'index.html',
    )
    .filter((m) => m.fatal);
  assert.deepEqual(problems, [], 'index.html did not parse');

  assert.ok(seen.includes('srStatus'), 'index.html lost #srStatus, the polite announcer');
  assert.deepEqual(
    inside,
    [],
    'a live region inside .app goes silent whenever a dialog is open, and redeeming a prize ' +
      'happens only inside a dialog',
  );
});
