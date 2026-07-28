/* Rasterises icons/icon.svg into the PNG sizes the web app manifest declares.

   Why this exists: the PNGs were originally produced by a hand run
   chrome-headless-shell command that lived only in a pull request description.
   That had two problems. The command hard coded a Playwright build number in its
   path, so a Playwright update silently invalidated it. And nothing tied the
   PNGs to the SVG, so editing the artwork left Android serving the old icon
   forever with every test still green.

   This drives Playwright's own API instead of a binary path, so the browser is
   resolved by the library that installed it and there is nothing to rot.

   Run: npm run icons     Check for drift: npm test (tests/icons.test.mjs)

   The PNGs are committed rather than generated at build time on purpose. The
   deploy job installs no browser, and a static site should not need one. */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SVG = join(ROOT, 'icons', 'icon.svg');

/* Sizes the manifest declares. Keep in step with manifest.webmanifest. */
export const SIZES = [192, 512];

/* Recorded so a test can tell whether the PNGs still match the artwork. Bump it
   by running this script, never by hand: editing it to silence the test is
   exactly the failure the test exists to catch. */
export const SOURCE_SHA256 = '765d8ffa1730977308c2f967a6ace5630f28830304a4be85b2428daa6ea02149';

export const svgHash = () => createHash('sha256').update(readFileSync(SVG)).digest('hex');

/* The SVG's rounded corners are transparent. A launcher mask closer to a square
   than a circle would punch four notches through them, so the page background
   fills the corners and "purpose: any maskable" stays honest. */
const wrapper = (svg) =>
  '<!doctype html><meta charset="utf-8"><style>' +
  'html,body{margin:0;padding:0;overflow:hidden;background:#C43A20}' +
  'svg{display:block;width:100vw;height:100vh}</style>' +
  svg;

async function render() {
  const { chromium } = await import('@playwright/test');
  const svg = readFileSync(SVG, 'utf8');
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      await page.setContent(wrapper(svg), { waitUntil: 'load' });
      const out = join(ROOT, 'icons', `icon-${size}.png`);
      await page.screenshot({ path: out, omitBackground: false });
      await page.close();
      console.log(`  wrote icons/icon-${size}.png`);
    }
  } finally {
    await browser.close();
  }

  /* Record the artwork this render came from, so drift is detectable. */
  const self = import.meta.filename;
  const src = readFileSync(self, 'utf8');
  const hash = svgHash();
  writeFileSync(
    self,
    src.replace(
      /export const SOURCE_SHA256 = '[^']*';/u,
      `export const SOURCE_SHA256 = '${hash}';`,
    ),
  );
  console.log(`  recorded source sha256 ${hash.slice(0, 16)}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await render();
}
