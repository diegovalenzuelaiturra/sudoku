/* Guards against the PNG icons going stale against the SVG they came from.

   Deliberately NOT by re-rendering and comparing bytes: a Chromium update can
   shift antialiasing by a pixel and fail this for no reason, and a guard that
   flakes gets deleted. Instead scripts/icons.mjs records the hash of the SVG it
   last rendered, and this asserts the artwork has not moved since. Cheap,
   deterministic, and needs no browser in CI. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SIZES, SOURCE_SHA256, svgHash } from '../scripts/icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the raster icons were generated from the current icon.svg', () => {
  assert.notEqual(
    SOURCE_SHA256,
    'PLACEHOLDER',
    'scripts/icons.mjs has never been run; run npm run icons',
  );
  assert.equal(
    svgHash(),
    SOURCE_SHA256,
    'icons/icon.svg changed but the PNGs were not regenerated. Run npm run icons. ' +
      'Do not edit SOURCE_SHA256 by hand, that only hides the drift.',
  );
});

test('every size the manifest declares exists as a real PNG of that size', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));

  for (const size of SIZES) {
    const rel = `icons/icon-${size}.png`;
    const file = join(root, rel);
    assert.ok(existsSync(file), `${rel} is missing`);

    /* Read width and height straight out of the PNG IHDR rather than trusting
       the filename: signature, then a 4 byte length, then "IHDR", then w and h
       as big endian uint32. */
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${rel} is not a PNG`);
    assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `${rel} has no IHDR`);
    assert.equal(bytes.readUInt32BE(16), size, `${rel} is not ${size} wide`);
    assert.equal(bytes.readUInt32BE(20), size, `${rel} is not ${size} tall`);

    const declared = manifest.icons.find((i) => i.src === rel);
    assert.ok(declared, `${rel} exists but the manifest does not declare it`);
    assert.equal(declared.sizes, `${size}x${size}`, `manifest declares the wrong size for ${rel}`);
  }
});
