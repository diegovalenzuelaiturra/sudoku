import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

const BANNED = [
  ['\u2014', 'EM DASH'],
  ['\u2013', 'EN DASH'],
  ['\u00B7', 'MIDDLE DOT'],
  ['\u2012', 'FIGURE DASH'],
  ['\u2015', 'HORIZONTAL BAR'],
];

/* .claude holds git worktrees, so from the main checkout the walk would descend
   into a full second copy of this repository for every branch someone has open,
   police files that belong to another branch, and let the file count asserted
   below be met without the real tree contributing anything. */
const SKIP_DIRS = new Set(['node_modules', '.git', '_site', '.claude']);
const SKIP_FILES = new Set(['package-lock.json']);

/* readFileSync(file, 'utf8') does not
   throw on bytes that are not valid utf8: it substitutes, and along the way a
   deflate stream can emit C2 B7, which decodes to a real MIDDLE DOT. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.zip',
  '.gz',
  '.pdf',
  '.mp3',
  '.mp4',
  '.wav',
  '.webm',
]);

const isBinary = (name) => BINARY_EXTENSIONS.has(extname(name).toLowerCase());

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    /* tests/site.test.mjs runs the build,
       which removes and recreates _site, and node --test runs test files in
       parallel processes, so statting an entry this walk was going to discard
       anyway can throw ENOENT and fail this unrelated test. */
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry) || isBinary(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function scan(text, label) {
  const offences = [];
  text.split('\n').forEach((line, i) => {
    for (const [char, name] of BANNED) {
      if (line.includes(char)) {
        offences.push(`${label}:${i + 1} [${name}] ${line.trim().slice(0, 90)}`);
      }
    }
  });
  return offences;
}

test('no em dashes, en dashes or middle dots anywhere in the source', () => {
  const offences = [];

  for (const file of walk(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    offences.push(...scan(text, relative(root, file)));
  }

  assert.deepEqual(
    offences,
    [],
    `use a comma, colon, semicolon or a rewritten sentence instead:\n  ${offences.join('\n  ')}`,
  );
});

test('the walk reaches the tree the check above claims to have read', () => {
  const files = walk(root).map((file) => relative(root, file).split(sep).join('/'));

  assert.ok(
    files.length >= 20,
    `the walk visited ${files.length} files, far fewer than this repository holds, so the ` +
      'check above passed without reading the tree',
  );

  for (const rel of [
    '.editorconfig',
    'index.html',
    'package.json',
    'scripts/build.mjs',
    'sw.js',
    'tests/typography.test.mjs',
  ]) {
    assert.ok(files.includes(rel), `the walk never reached ${rel}, so its contents went unchecked`);
  }
});

test('the scan still reports every character it exists to find', () => {
  const REQUIRED = [
    ['\u2014', 'EM DASH'],
    ['\u2013', 'EN DASH'],
    ['\u00B7', 'MIDDLE DOT'],
  ];

  for (const [char, name] of [...REQUIRED, ...BANNED]) {
    const codePoint = `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    const found = scan(`a line that holds one ${char} and nothing else`, 'control');
    assert.equal(
      found.length,
      1,
      `the scan returned ${found.length} offences for a line holding a single ${name} ` +
        `(${codePoint}), so the empty result asserted above proves nothing about the tree`,
    );
  }
});
