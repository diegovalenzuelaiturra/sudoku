import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SVG = join(ROOT, 'icons', 'icon.svg');

const MANIFEST = join(ROOT, 'manifest.webmanifest');

/**
 * The raster icons the manifest declares, which are exactly the files render() writes.
 * @type {ReadonlyArray<{ src: string, size: number }>}
 */
export const PNG_ICONS = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  .icons.filter((icon) => icon.type === 'image/png')
  .map(({ src, sizes }) => {
    const square = /^(\d+)x\1$/u.exec(sizes);
    if (!square) {
      throw new Error(
        `manifest.webmanifest declares ${src} as ${sizes}, and only one square size can be rendered`,
      );
    }
    return { src, size: Number(square[1]) };
  });

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
    for (const { src, size } of PNG_ICONS) {
      const page = await browser.newPage({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      await page.setContent(wrapper(svg), { waitUntil: 'load' });
      await page.screenshot({ path: join(ROOT, src), omitBackground: false });
      await page.close();
      console.log(`  wrote ${src}`);
    }
  } finally {
    await browser.close();
  }

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
