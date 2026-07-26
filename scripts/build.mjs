#!/usr/bin/env node
/* Assembles the publishable site into _site/ from an explicit ALLOWLIST.

   Why a script rather than "cp index.html _site/" inline in the deploy workflow:
   the inline copy was never exercised by CI, so the day a second file joined the
   site nothing would have caught its absence. It would have shipped as a silent
   404. This runs in the test job too, and a test can import ALLOWLIST.

   Why an allowlist and not an allow-everything-minus-a-denylist: a denylist
   publishes whatever you forgot to name. Tests, node_modules, package.json,
   package-lock.json, .github, scripts and the playwright config are not excluded
   here by rule; they are simply never reachable, because only the entries below
   are ever read. Fail closed.

   Optional entries are skipped without comment when absent. The site grows one
   file at a time and the allowlist is allowed to run ahead of the tree. */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* The complete set of things that may be published, in publication order.
   type 'dir' is copied recursively; dotfiles are dropped at every level.
   Adding a file to the site means adding it here, and nowhere else. */
export const ALLOWLIST = [
  { path: 'index.html', type: 'file', required: true },
  { path: '404.html', type: 'file', required: false },
  { path: 'manifest.webmanifest', type: 'file', required: false },
  { path: 'sw.js', type: 'file', required: false },
  { path: 'robots.txt', type: 'file', required: false },
  { path: 'icons', type: 'dir', required: false },
];

/* Replaced with the build id everywhere it appears in a text file. The service
   worker uses it as its cache name: a build that reuses the previous id pins
   every returning visitor to the cache it already has. */
export const PLACEHOLDER = '__BUILD__';

/* A build id is spliced verbatim into published JavaScript, JSON and HTML, so
   it is held to what a cache name may safely contain: no quotes, no newlines,
   no path separators. A commit SHA passes. A value that could close a string
   literal and keep going, which is a script injection into a file the browser
   runs with origin scope, does not. */
export const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/* Only these are decoded as text for placeholder substitution. Anything else,
   an icon PNG for instance, is copied byte for byte and never re-encoded. */
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
]);

const isText = (relPath) => TEXT_EXTENSIONS.has(extname(relPath).toLowerCase());

/* A symlink could point anywhere, including outside the repository, so it is an
   error rather than something to follow quietly. */
function inspect(root, relPath) {
  const stat = lstatSync(join(root, relPath), { throwIfNoEntry: false });
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`refusing to publish a symlink: ${relPath}`);
  }
  return stat;
}

function walkDir(root, relDir) {
  const found = [];
  for (const name of readdirSync(join(root, relDir)).sort()) {
    if (name.startsWith('.')) continue;
    const relPath = `${relDir}/${name}`;
    const stat = inspect(root, relPath);
    if (stat.isDirectory()) found.push(...walkDir(root, relPath));
    else if (stat.isFile()) found.push(relPath);
    else throw new Error(`not a regular file: ${relPath}`);
  }
  return found;
}

function collect(root) {
  const paths = [];
  const skipped = [];

  for (const entry of ALLOWLIST) {
    const stat = inspect(root, entry.path);

    if (!stat) {
      if (entry.required) {
        throw new Error(`required allowlist entry is missing: ${entry.path}`);
      }
      skipped.push(entry.path);
      continue;
    }

    if (entry.type === 'dir') {
      if (!stat.isDirectory()) {
        throw new Error(`allowlisted as a directory but is not one: ${entry.path}`);
      }
      const files = walkDir(root, entry.path);
      if (files.length === 0) skipped.push(`${entry.path}/ (empty)`);
      paths.push(...files);
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`allowlisted as a file but is not one: ${entry.path}`);
    }
    paths.push(entry.path);
  }

  return { paths, skipped };
}

/* Deterministic: ALLOWLIST order plus sorted directory entries, hashed over
   path and content, so the same tree yields the same id on any machine. Taken
   before substitution, because the substituted text contains the id itself. */
function contentHash(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.source);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/* rmSync with recursive on the output directory is the one destructive act
   here, so refuse anything that would take the repository with it. */
function cleanOutDir(outDir, root) {
  const out = resolve(outDir);
  if (out === dirname(out) || out === resolve(root) || resolve(root).startsWith(out + sep)) {
    throw new Error(`refusing to clean ${out}: it holds the repository root`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}

export function build({ root = REPO_ROOT, outDir, buildId } = {}) {
  const target = resolve(outDir ?? join(root, '_site'));
  const { paths, skipped } = collect(root);

  const files = paths.map((path) => ({ path, source: readFileSync(join(root, path)) }));

  const envId = (buildId ?? process.env.BUILD_ID ?? '').trim();
  if (envId !== '' && !BUILD_ID_PATTERN.test(envId)) {
    throw new Error(
      `refusing to publish with BUILD_ID ${JSON.stringify(envId)}: ` +
        `a build id must match ${BUILD_ID_PATTERN}`,
    );
  }
  const id = envId || contentHash(files);
  const idSource = envId ? 'BUILD_ID' : 'content hash';

  cleanOutDir(target, root);

  const published = [];
  for (const file of files) {
    let data = file.source;
    let substitutions = 0;

    if (isText(file.path)) {
      const parts = file.source.toString('utf8').split(PLACEHOLDER);
      substitutions = parts.length - 1;
      if (substitutions > 0) data = Buffer.from(parts.join(id), 'utf8');
    }

    const dest = join(target, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    published.push({ path: file.path, bytes: data.byteLength, substitutions });
  }

  return { buildId: id, idSource, outDir: target, files: published, skipped };
}

function main() {
  const result = build();
  const where = relative(process.cwd(), result.outDir) || result.outDir;

  console.log(`published ${result.files.length} file(s) to ${where}/`);
  for (const file of result.files) {
    const subs = file.substitutions
      ? `, ${file.substitutions} ${PLACEHOLDER} substitution(s)`
      : '';
    console.log(`  ${file.path} (${file.bytes} bytes${subs})`);
  }
  if (result.skipped.length > 0) {
    console.log(`not present, skipped: ${result.skipped.join(', ')}`);
  }
  console.log(`build id: ${result.buildId} (${result.idSource})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
