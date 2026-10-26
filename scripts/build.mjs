#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { minify as minifyHtml } from 'html-minifier-terser';
import { transform as transformCss } from 'lightningcss';
import { minify as minifyJs } from 'terser';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export const ALLOWLIST = [
  { path: 'index.html', type: 'file', required: true },
  { path: '404.html', type: 'file', required: false },
  { path: 'manifest.webmanifest', type: 'file', required: false },
  { path: 'sw.js', type: 'file', required: false },
  { path: 'generator.js', type: 'file', required: true },
  { path: 'icons', type: 'dir', required: false },
];

export const PLACEHOLDER = '__BUILD__';

export const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

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

function inspect(root, relPath) {
  const stat = lstatSync(join(root, relPath), { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    throw new Error(`refusing to publish a symlink: ${relPath}`);
  }
  return stat;
}

function walkDir(root, relDir) {
  const found = [];
  for (const name of readdirSync(join(root, relDir)).toSorted()) {
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

const INLINED_SCRIPTS = new Set(['app.js', 'stats.js']);

const SCRIPT_TAG = /[ \t]*<script\s+src="([^"]+)"\s*>\s*<\/script>/gu;

function inlineScripts(root, files) {
  for (const file of files) {
    if (extname(file.path).toLowerCase() !== '.html') continue;
    const html = file.source.toString('utf8');
    let touched = false;

    const next = html.replace(SCRIPT_TAG, (whole, src) => {
      if (!INLINED_SCRIPTS.has(src)) return whole;
      const from = join(root, src);
      if (!inspect(root, src)?.isFile()) {
        throw new Error(`${file.path} inlines ${src}, which does not exist`);
      }
      touched = true;
      const indent = whole.slice(0, whole.length - whole.trimStart().length);
      return `${indent}<script>\n${readFileSync(from, 'utf8').trimEnd()}\n${indent}</script>`;
    });

    if (touched) file.source = Buffer.from(next, 'utf8');
  }
  return files;
}

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

  const files = inlineScripts(
    root,
    paths.map((path) => ({ path, source: readFileSync(join(root, path)) })),
  );

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

const version = (major, minor = 0, patch = 0) => (major << 16) | (minor << 8) | patch;

/* user-select and backdrop-filter both need -webkit- at Safari 15.4 and
   neither carries it in the source, so the built page now grows the prefixes
   instead of quietly dropping the declarations on the oldest browser in scope. */
const CSS_TARGETS = {
  safari: version(15, 4),
  chrome: version(100),
  firefox: version(98),
  edge: version(100),
};

/* html-minifier-terser calls this for three kinds of text and says which:
   a <style> body, a style attribute, and a media attribute. lightningcss parses
   a stylesheet, so the last two are wrapped into one and unwrapped after. */
const minifyCss = (text, type) => {
  const run = (code) =>
    transformCss({
      filename: 'index.css',
      code: Buffer.from(code),
      minify: true,
      targets: CSS_TARGETS,
    }).code.toString();

  if (type === 'inline') {
    const out = run(`a{${text}}`);
    return out.slice(out.indexOf('{') + 1, out.lastIndexOf('}'));
  }
  if (type === 'media') {
    const out = run(`@media ${text}{a{color:red}}`);
    return out.slice('@media '.length, out.indexOf('{'));
  }
  return run(text);
};

const HTML_MINIFY_OPTIONS = {
  removeComments: true,
  /* One exception, and it is not a preference. The button sprite is Material
     Symbols under Apache-2.0, whose section 4(d) requires the attribution
     notice to travel with the derivative work. The sprite is inlined into
     index.html, so the published copy is the distribution, and removeComments
     was deleting the only notice it carried: NOTICE is repository metadata and
     is not in the allowlist. Kept by pattern rather than by rewriting the
     comment as <!--! ... -->, so the source stays readable prose. */
  ignoreCustomComments: [/Material Symbols/u],
  collapseWhitespace: true,
  minifyCSS: minifyCss,
  minifyJS: true,
};

const JS_MINIFY_OPTIONS = { format: { comments: false } };

const MINIFIERS = new Map([
  ['.html', (source) => minifyHtml(source, HTML_MINIFY_OPTIONS)],
  ['.js', async (source) => (await minifyJs(source, JS_MINIFY_OPTIONS)).code],
]);

export async function minifySite({ outDir, files }) {
  const minified = [];

  for (const file of files) {
    const minify = MINIFIERS.get(extname(file.path).toLowerCase());
    if (!minify) continue;

    const dest = join(outDir, file.path);
    const before = readFileSync(dest, 'utf8');
    const after = await minify(before);

    if (typeof after !== 'string' || after === '') {
      throw new Error(`minifying ${file.path} produced no output`);
    }

    writeFileSync(dest, after, 'utf8');
    file.bytes = Buffer.byteLength(after, 'utf8');

    minified.push({
      path: file.path,
      before: Buffer.byteLength(before, 'utf8'),
      after: Buffer.byteLength(after, 'utf8'),
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
    const subs = file.substitutions ? `, ${file.substitutions} ${PLACEHOLDER} substitution(s)` : '';
    const saved = savings.get(file.path);
    const shrunk = saved
      ? `, minified from ${saved.before} (gzipped ${saved.beforeGzip} -> ${saved.afterGzip})`
      : '';
    console.log(`  ${file.path} (${file.bytes} bytes${subs}${shrunk})`);
  }
  if (result.skipped.length > 0) {
    console.log(`not present, skipped: ${result.skipped.join(', ')}`);
  }

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

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
