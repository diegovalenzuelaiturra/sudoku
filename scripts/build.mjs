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
import { gzipSync } from 'node:zlib';

/* The only two imports here that are not node builtins, and they cost the
   deploy job an npm ci. That job used to install nothing, which kept the whole
   dependency tree out of the one place that can publish to Pages and mint an
   OIDC token, so this is a real trade and not a free one. It is made because
   minifying the page is worth about a third of what it costs on the wire and
   there is no way to do that with builtins alone.

   Both are devDependencies and neither is ever served: they run here, at build
   time, over bytes that have already been written, and nothing they produce
   imports them back. Both are plain JavaScript with no lifecycle scripts and
   no native build, so npm ci --ignore-scripts installs them completely. */
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJs } from 'terser';

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

/* Conservative on purpose, and the numbers are why rather than an instinct.
   Measured on this page, against gzip, which is what GitHub Pages actually
   serves and therefore the only size a visitor pays. Each line switches on one
   more option than the line above it:

     unminified                       15276 gzipped
     removeComments                   14531
     + collapseWhitespace below       14457
     + minifyCSS and minifyJS         10457
     + removeAttributeQuotes          10426
     + collapseBooleanAttributes      10426

   So the entire win is the two sub-minifiers: the document is 25 percent CSS
   and 52 percent JS, and everything a markup only pass can do is worth 819 of
   the 4819 bytes. The last two lines are the reason the aggressive options are
   off. Thirty one gzipped bytes, three tenths of one percent of what is
   served, in exchange for rewriting every attribute in an inline SVG sprite,
   and the boolean attributes on this page are worth exactly nothing. That is
   not a trade, it is a dare.

   Dropping comments applies to the published copy only. index.html keeps every
   one of its own: several exist specifically to stop a fixed bug being put
   back, so deleting them from the file people edit would be the regression
   this is supposed to be an optimisation for. */
const HTML_MINIFY_OPTIONS = {
  removeComments: true,
  /* conservativeCollapse squeezes a run of whitespace down to a single space
     instead of deleting it at element boundaries. The toolbar buttons are
     inline elements whose spacing is that whitespace, so the full collapse can
     move the layout; it is worth 9 more gzipped bytes than this one. */
  collapseWhitespace: true,
  conservativeCollapse: true,
  minifyCSS: true,
  minifyJS: true,
};

/* Left at terser's defaults, which do not mangle top level names. sw.js is
   read by the browser as a script and not a module, and its cache name is
   spliced in before this runs, so there is nothing here worth the risk of
   renaming. Comments go; the placeholder is already a build id by now. */
const JS_MINIFY_OPTIONS = { format: { comments: false } };

const MINIFIERS = new Map([
  ['.html', (source) => minifyHtml(source, HTML_MINIFY_OPTIONS)],
  ['.js', async (source) => (await minifyJs(source, JS_MINIFY_OPTIONS)).code],
]);

/* Rewrites published files in place, after the placeholder substitution rather
   than before it: the minifiers then only ever see a finished build id, and
   cannot fold or reorder a string that still had __BUILD__ in it.

   Driven by the list build() returned, never by walking the output directory,
   so it can only touch bytes the allowlist put there. A file type with no
   entry in MINIFIERS is left exactly as it was published, which is what keeps
   this away from the icon PNGs and the manifest.

   Anything that throws here fails the build. There is deliberately no fall
   back to the unminified bytes: a deploy that quietly shipped the large copy
   whenever the minifier tripped would be indistinguishable from a working one
   until somebody measured it. */
export async function minifySite({ outDir, files }) {
  const minified = [];

  for (const file of files) {
    const minify = MINIFIERS.get(extname(file.path).toLowerCase());
    if (!minify) continue;

    const dest = join(outDir, file.path);
    const before = readFileSync(dest, 'utf8');
    const after = await minify(before);

    /* A minifier that returns nothing at all has not made the file smaller,
       it has deleted it, and an empty index.html is a blank page that serves
       a 200. */
    if (typeof after !== 'string' || after === '') {
      throw new Error(`minifying ${file.path} produced no output`);
    }

    writeFileSync(dest, after, 'utf8');
    file.bytes = Buffer.byteLength(after, 'utf8');

    minified.push({
      path: file.path,
      before: Buffer.byteLength(before, 'utf8'),
      after: Buffer.byteLength(after, 'utf8'),
      /* Reported next to the raw numbers because they disagree, and the
         gzipped pair is the honest one: comments and indentation are the most
         compressible bytes in the file, so a large raw saving routinely turns
         into a much smaller saving on the wire. */
      beforeGzip: gzipSync(Buffer.from(before, 'utf8'), { level: 9 }).byteLength,
      afterGzip: gzipSync(Buffer.from(after, 'utf8'), { level: 9 }).byteLength,
    });
  }

  return minified;
}

async function main() {
  const result = build();
  const minified = await minifySite(result);
  const savings = new Map(minified.map((file) => [file.path, file]));
  const where = relative(process.cwd(), result.outDir) || result.outDir;

  console.log(`published ${result.files.length} file(s) to ${where}/`);
  for (const file of result.files) {
    const subs = file.substitutions
      ? `, ${file.substitutions} ${PLACEHOLDER} substitution(s)`
      : '';
    const saved = savings.get(file.path);
    const shrunk = saved
      ? `, minified from ${saved.before} (gzipped ${saved.beforeGzip} -> ${saved.afterGzip})`
      : '';
    console.log(`  ${file.path} (${file.bytes} bytes${subs}${shrunk})`);
  }
  if (result.skipped.length > 0) {
    console.log(`not present, skipped: ${result.skipped.join(', ')}`);
  }

  /* Totalled over the files that were minified, and stated in both units. The
     gzipped column is the one to watch: it is what the server sends. */
  if (minified.length > 0) {
    const sum = (key) => minified.reduce((total, file) => total + file[key], 0);
    const percent = (from, to) => `${(((from - to) / from) * 100).toFixed(1)}%`;
    console.log(
      `minified ${minified.length} file(s): ` +
        `${sum('before')} -> ${sum('after')} bytes (-${percent(sum('before'), sum('after'))}), ` +
        `gzipped ${sum('beforeGzip')} -> ${sum('afterGzip')} ` +
        `(-${percent(sum('beforeGzip'), sum('afterGzip'))})`,
    );
  }

  console.log(`build id: ${result.buildId} (${result.idSource})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
