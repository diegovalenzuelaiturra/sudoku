import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { runInNewContext } from 'node:vm';

import { ALLOWLIST, build } from '../scripts/build.mjs';

const root = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const scratch = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/* child_process copies NODE_V8_COVERAGE back into an env that lacks it, so it
   is emptied rather than deleted, or the files a child loads join the report. */
const childEnv = (extra = {}) => {
  const env = { ...process.env, ...extra, NODE_V8_COVERAGE: '' };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

const publishedCopy = (t) => {
  const out = join(scratch(t, 'sudoku-constraints-build-'), '_site');
  build({ root, outDir: out, buildId: 'constraints' });
  return walk(out).map((file) => ({
    path: relative(out, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));
};

const importSpecifiers = (source) =>
  [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]);

test('LICENSE stays in the repository and is never published', (t) => {
  assert.ok(
    existsSync(join(root, 'LICENSE')),
    'LICENSE is gone, and a public repository without one reserves all rights',
  );
  assert.ok(
    !ALLOWLIST.some((entry) => entry.path === 'LICENSE'),
    'the build allowlist publishes LICENSE, which is repository metadata and adds nothing to the game',
  );
  const shipped = publishedCopy(t).map((file) => file.path);
  assert.ok(shipped.includes('index.html'), 'the scratch build published no index.html');
  assert.ok(
    !shipped.some((path) => /^(license|licence)(\.|$)/iu.test(path.split('/').at(-1))),
    `the build published a licence file: ${shipped.join(', ')}`,
  );
});

test('the canonical origin is written only in the social metadata', (t) => {
  const shipped = publishedCopy(t);
  const page = shipped.find((file) => file.path === 'index.html').text;
  const link = page.match(/<link\s[^>]*rel="canonical"[^>]*>/u)?.[0] ?? '';
  const canonical = link.match(/href="([^"]+)"/u)?.[1];
  assert.ok(canonical, 'the published page declares no canonical link to take the origin from');
  const host = new URL(canonical).host;

  const SOCIAL = [
    /<meta\s[^>]*(?:property|name)="(?:og|twitter):[^"]*"[^>]*>/gu,
    /<link\s[^>]*rel="canonical"[^>]*>/gu,
  ];
  const social = SOCIAL.flatMap((re) => page.match(re) ?? []).filter((tag) => tag.includes(host));
  assert.ok(
    social.length > 0,
    `no og:, twitter: or canonical tag names ${host}, so the check below saw nothing allowed`,
  );

  const offences = [];
  for (const { path, text } of shipped) {
    const rest = SOCIAL.reduce((left, re) => left.replace(re, ''), text);
    rest.split('\n').forEach((line, i) => {
      if (line.includes(host)) offences.push(`${path}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    offences,
    [],
    `${host} is written outside the social metadata. Every other path has to stay relative, ` +
      `because the site is served under a prefix on a shared domain:\n  ${offences.join('\n  ')}`,
  );
});

test('the icon staleness guard passes on a machine with no browser installed', (t) => {
  const noBrowsers = scratch(t, 'sudoku-constraints-browsers-');
  const env = childEnv({ PLAYWRIGHT_BROWSERS_PATH: noBrowsers });

  const run = spawnSync(process.execPath, ['--test', join(root, 'tests', 'icons.test.mjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(
    run.status,
    0,
    'tests/icons.test.mjs fails once no browser is installed, so it now renders the icons ' +
      'instead of comparing the source hash, and a renderer update that shifts antialiasing by ' +
      `a pixel will fail it for no reason:\n${run.stdout}\n${run.stderr}`,
  );
});

test('the published worker check holds its own placeholder literal, not the build export', () => {
  const source = read('tests/site.test.mjs');

  const fromBuild = importSpecifiers(source).filter((spec) =>
    /scripts\/build(\.mjs)?$/u.test(spec),
  );
  assert.deepEqual(
    fromBuild,
    [],
    'tests/site.test.mjs imports scripts/build.mjs, so it would ask the build what it ' +
      'substitutes and could no longer see the build and the worker disagree',
  );
  assert.match(
    source,
    /__BUILD__/u,
    'tests/site.test.mjs no longer writes the placeholder out, so nothing independent of the ' +
      'build says what _site/sw.js must not contain',
  );
});

test('the independent oracle takes nothing from generator.js but makePuzzle', () => {
  const source = read('tests/oracle.test.mjs');

  const external = importSpecifiers(source).filter((spec) => !spec.startsWith('node:'));
  assert.deepEqual(
    external,
    [],
    'tests/oracle.test.mjs imports repository code, so the oracle can share the bug it checks for',
  );

  const loaded = [...source.matchAll(/require\(([^)]*)\)/gu)].map((match) => match[1]);
  assert.ok(loaded.length > 0, 'tests/oracle.test.mjs no longer loads generator.js at all');
  for (const target of loaded) {
    assert.match(
      target,
      /['"]generator\.js['"]/u,
      `tests/oracle.test.mjs requires ${target}, and the oracle may load nothing but the generator`,
    );
  }

  const taken = [];
  for (const line of source.split('\n').filter((l) => l.includes('SudokuGenerator'))) {
    if (/^\s*delete globalThis\.SudokuGenerator;?\s*$/u.test(line)) continue;
    const names = line.match(/^\s*const\s*\{([^}]*)\}\s*=\s*globalThis\.SudokuGenerator;?\s*$/u);
    if (names) taken.push(...names[1].split(',').map((name) => name.trim()));
    else taken.push(`(unrecognised) ${line.trim()}`);
  }
  assert.deepEqual(
    taken,
    ['makePuzzle'],
    'the oracle reads more of SudokuGenerator than makePuzzle, so it grades boards with the ' +
      'tables or the solver it exists to check against',
  );
});

test('the accent guard never watches a word that is also right without its accent', () => {
  const source = read('tests/accents.test.mjs');
  const start = source.indexOf('const ACCENTED = [');
  assert.ok(start !== -1, 'tests/accents.test.mjs no longer declares ACCENTED');
  const list = source.slice(start, source.indexOf('];', start));
  const pairs = [...list.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/gu)].map((m) => m.slice(1));
  assert.ok(pairs.length >= 10, `read ${pairs.length} pairs out of ACCENTED, so the parse is off`);

  const RIGHT_BARE = ['mas', 'si', 'tu', 'el', 'solo', 'numero', 'esta', 'papa'];
  const ENGLISH = ['record', 'version'];
  const offences = pairs
    .filter(([, bare]) => [...RIGHT_BARE, ...ENGLISH].includes(bare.toLowerCase()))
    .map(([accented, bare]) => `${accented} / ${bare}`);
  assert.deepEqual(
    offences,
    [],
    'ACCENTED watches a bare form that is correct in ordinary Spanish or is an English word ' +
      'in the same files, so the guard would fail on correct text and be switched off',
  );
});

async function serve(t, args, extraEnv = {}) {
  const dir = scratch(t, 'sudoku-constraints-server-');
  mkdirSync(join(dir, 'e2e'));
  mkdirSync(join(dir, '_site'));
  writeFileSync(join(dir, '_site', 'index.html'), 'served');
  copyFileSync(join(root, 'e2e', 'static-server.mjs'), join(dir, 'e2e', 'static-server.mjs'));

  const env = childEnv(extraEnv);
  if (!('PLAYWRIGHT_PORT' in extraEnv)) delete env.PLAYWRIGHT_PORT;
  const child = spawn(process.execPath, [join(dir, 'e2e', 'static-server.mjs'), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const line = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no serving line in 10s: ${stderr}`)), 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const found = stdout.match(/^serving .*$/mu);
      if (found) {
        clearTimeout(timer);
        done(found[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`the server exited with ${code} before serving: ${stderr}`));
    });
  });
  const url = new URL(line.slice(line.indexOf('http://')));
  return { line, url };
}

test('the e2e server takes its port from the argument before PLAYWRIGHT_PORT', async (t) => {
  const holder = createServer();
  await new Promise((done) => holder.listen(0, '127.0.0.1', done));
  t.after(() => holder.close());
  const taken = String(holder.address().port);

  const started = serve(t, ['0'], { PLAYWRIGHT_PORT: taken });
  await assert.doesNotReject(
    started,
    'asked for port 0 with PLAYWRIGHT_PORT naming a port already in use, the server tried the ' +
      'PLAYWRIGHT_PORT one, so the second server e2e/boot.spec.mjs starts would land on the ' +
      'port the suite is already using',
  );
  const { url } = await started;

  assert.notEqual(
    url.port,
    taken,
    'asked for port 0 with PLAYWRIGHT_PORT set, the server took the suite port instead, which ' +
      'is the port the second server in e2e/boot.spec.mjs must stay off',
  );
  assert.notEqual(url.port, '0', 'the serving line reports port 0 instead of the port it bound');
  const answer = await fetch(new URL('./', url));
  assert.equal(answer.status, 200, 'the server on the port it reported does not answer');
});

test('the e2e server mounts the site under /sudoku/ unless told otherwise', async (t) => {
  const { line, url } = await serve(t, ['0']);

  assert.match(
    line,
    /\/sudoku\/$/u,
    'with no base argument the server mounts the site somewhere other than /sudoku/, so a ' +
      'caller that says nothing gets the root mount that hides absolute paths',
  );
  const inside = await fetch(url);
  assert.equal(inside.status, 200, `${url} does not serve the site`);
  assert.equal(await inside.text(), 'served');
  const outside = await fetch(new URL('/index.html', url));
  assert.equal(
    outside.status,
    404,
    'the site answers outside /sudoku/, so an absolute path would load locally and 404 on Pages',
  );
});

test('the e2e server is written on node builtins, with no static server package', () => {
  const external = importSpecifiers(read('e2e/static-server.mjs')).filter(
    (spec) => !spec.startsWith('node:'),
  );
  assert.deepEqual(
    external,
    [],
    'e2e/static-server.mjs imports a package, and the install runs with --ignore-scripts to ' +
      'keep the supply chain small, so serving one directory must not pull in a package tree',
  );

  const SERVERS = [
    'serve',
    'serve-handler',
    'serve-static',
    'http-server',
    'sirv',
    'sirv-cli',
    'live-server',
    'lite-server',
    'local-web-server',
    'express',
    'connect',
    'koa',
    'fastify',
    'polka',
    'browser-sync',
    'vite',
    '@web/dev-server',
  ];
  const { dependencies = {}, devDependencies = {} } = JSON.parse(read('package.json'));
  const declared = SERVERS.filter((name) => name in dependencies || name in devDependencies);
  assert.deepEqual(declared, [], 'package.json declares a static server package');
});

test('every update spec runs on WebKit as well as Chromium', () => {
  const source = read('e2e/update.spec.mjs');
  for (const [pattern, what] of [
    [/\.(?:skip|fixme|fail|only)\s*\(/u, 'skips, marks or isolates a test'],
    [/browserName|project\.name|testInfo\.project/u, 'branches on the engine'],
  ]) {
    assert.doesNotMatch(
      source,
      pattern,
      `e2e/update.spec.mjs ${what}. Its subject is an installed app, and every installed ` +
        'copy on iOS runs on WebKit, so no test in it may be gated to one project',
    );
  }

  const listed = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '--list',
      '--reporter=json',
      'e2e/update.spec.mjs',
    ],
    { cwd: root, env: childEnv(), encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(listed.status, 0, `playwright could not list the specs:\n${listed.stderr}`);

  const byProject = new Map();
  const collect = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const run of spec.tests) {
        if (!byProject.has(run.projectName)) byProject.set(run.projectName, new Set());
        byProject.get(run.projectName).add(spec.title);
      }
    }
    for (const child of suite.suites ?? []) collect(child);
  };
  for (const suite of JSON.parse(listed.stdout).suites) collect(suite);

  const chromium = [...(byProject.get('chromium') ?? [])].toSorted();
  assert.ok(chromium.length > 0, 'playwright lists no update spec on chromium');
  assert.deepEqual(
    [...(byProject.get('webkit') ?? [])].toSorted(),
    chromium,
    'the webkit project does not run every update spec chromium runs',
  );
});

test('the e2e wallet version is the version app.js writes', () => {
  const version = (rel) => {
    const found = read(rel).match(/\bWALLET_VERSION\s*=\s*(\d+)/u);
    assert.ok(found, `${rel} no longer declares WALLET_VERSION`);
    return Number(found[1]);
  };
  assert.equal(
    version('e2e/rewards.spec.mjs'),
    version('app.js'),
    'the e2e copy of WALLET_VERSION has drifted from app.js, so the wallet planted as one past ' +
      'it may be one this build reads, and the unknown version test stops meaning anything',
  );
  assert.doesNotMatch(
    read('e2e/rewards.spec.mjs'),
    /\bv:\s*\d+\s*,\s*fries\b/u,
    'a wallet fixture in e2e/rewards.spec.mjs pins its version to a literal instead of ' +
      'following WALLET_VERSION',
  );
});

function topLevelLiteral(source, name) {
  const start = source.search(new RegExp(`^const ${name} = [\\[{]`, 'mu'));
  if (start === -1) return null;
  const open = source.indexOf('=', start) + 2;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if ('[{'.includes(source[i])) depth++;
    if (']}'.includes(source[i])) depth--;
    if (depth === 0) return source.slice(open, i + 1);
  }
  return null;
}

test('the payouts and labels the e2e specs expect are written out, not read from the game', () => {
  const FIXTURES = [
    ['e2e/record.spec.mjs', 'NORMAL'],
    ['e2e/rewards.spec.mjs', 'NORMAL'],
    ['e2e/rewards.spec.mjs', 'HARD'],
    ['e2e/progress.spec.mjs', 'PELUDO'],
    ['e2e/boot.spec.mjs', 'PRESETS'],
  ];
  for (const [rel, name] of FIXTURES) {
    const literal = topLevelLiteral(read(rel), name);
    assert.ok(literal, `${rel} no longer declares ${name} as a top level literal`);
    assert.doesNotThrow(
      () => runInNewContext(`(${literal})`, Object.create(null)),
      `${rel} builds ${name} out of something other than literals, so a table edited by ` +
        'accident in app.js would agree with itself instead of failing',
    );
  }

  const readers = readdirSync(join(root, 'e2e'))
    .filter((name) => name.endsWith('.spec.mjs'))
    .filter((name) => /\bDIFF\b/u.test(read(`e2e/${name}`)));
  assert.deepEqual(
    readers,
    [],
    'an e2e spec reads the DIFF table out of the page, so its expected payouts are whatever ' +
      'the game says they are',
  );
});

test('the mid animation test presses Nueva partida straight after the last digit', () => {
  const source = read('e2e/rewards.spec.mjs');
  const title = 'starting the next puzzle mid animation still shows what the win paid';
  const start = source.indexOf(`test('${title}'`);
  assert.ok(start !== -1, `e2e/rewards.spec.mjs no longer holds the test "${title}"`);
  const end = source.indexOf('\ntest(', start + 1);
  const lines = source
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const solved = lines.findIndex((line) => /\bsolve\(page\)/u.test(line));
  assert.ok(solved !== -1, `"${title}" no longer solves the board`);
  assert.match(
    lines[solved + 1] ?? '',
    /#newBtn/u,
    `"${title}" does something between the last digit and Nueva partida. Anything awaited ` +
      'there lets the win animation finish first, and the test stops covering the case it names',
  );
});
