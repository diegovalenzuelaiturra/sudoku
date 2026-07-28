/* Boots index.html in jsdom and asserts the page comes up clean.

   Regression target: `notes` was declared as an empty array while render() read
   notes[i].has(d) for all 81 cells, so the boot-time render() threw on the first
   cell. The exception escaped, the statements after it never ran, and the page
   loaded to a dead grid with no difficulty picker. The "boots without throwing"
   and "start dialog is shown" assertions below both fail on that bug. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/* Kept in sync with the DIFF map in index.html. */
const PRESETS = [
  { key: 'easy', label: 'Piola', clues: 40 },
  { key: 'medium', label: 'Normal', clues: 34 },
  { key: 'hard', label: 'Peludo', clues: 28 },
  { key: 'expert', label: 'Brígido', clues: 24 },
];

function boot() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/sudoku/',
    virtualConsole,
    beforeParse(window) {
      /* jsdom implements no matchMedia; index.html queries prefers-reduced-motion. */
      window.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      });
    },
  });

  return { dom, window: dom.window, document: dom.window.document, errors };
}

test('boots without throwing', () => {
  const { errors, dom } = boot();
  assert.deepEqual(errors, [], 'page threw during boot');
  dom.window.close();
});

test('start dialog is shown, labelled, and traps focus', () => {
  const { document, errors, dom } = boot();

  const overlay = document.getElementById('startOverlay');
  assert.ok(overlay.classList.contains('show'), 'start overlay is not shown on load');

  const modal = overlay.querySelector('.modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.ok(modal.getAttribute('aria-labelledby'), 'dialog has no accessible name');

  /* Asserted via the IDL property, not hasAttribute: browsers reflect `inert`
     to a content attribute but jsdom does not, and the page sets the property. */
  assert.equal(
    document.querySelector('.app').inert,
    true,
    'background is not inert while the dialog is open',
  );
  assert.ok(
    overlay.contains(document.activeElement),
    'focus was not moved into the dialog',
  );

  assert.deepEqual(errors, []);
  dom.window.close();
});

test('board renders 81 labelled cells and an empty-state count', () => {
  const { document, errors, dom } = boot();

  const cells = document.querySelectorAll('#board .cell');
  assert.equal(cells.length, 81);

  /* render() aborting mid-loop leaves cells without aria-labels. */
  for (const cell of cells) {
    assert.match(cell.getAttribute('aria-label') ?? '', /Fila \d, columna \d/);
  }

  assert.equal(document.getElementById('remaining').textContent.trim(), '81 por llenar');
  assert.equal(document.getElementById('mistakes').textContent.trim(), '0');
  assert.equal(document.getElementById('hints').textContent.trim(), '0');

  assert.deepEqual(errors, []);
  dom.window.close();
});

test('difficulty labels match the clue counts they deal', () => {
  const { document, errors, dom } = boot();

  for (const preset of PRESETS) {
    const button = document.querySelector(`#startOverlay button.diff[data-d="${preset.key}"]`);
    assert.ok(button, `no button for difficulty ${preset.key}`);
    const text = button.textContent;
    assert.ok(
      text.includes(preset.label),
      `${preset.key} button reads "${text}", expected label ${preset.label}`,
    );
    assert.ok(
      text.includes(String(preset.clues)),
      `${preset.key} button reads "${text}", expected ${preset.clues} clues`,
    );
  }

  assert.deepEqual(errors, []);
  dom.window.close();
});

for (const preset of PRESETS) {
  test(`starting ${preset.label} deals ${preset.clues} clues and dismisses the dialog`, () => {
    const { document, errors, dom } = boot();

    document.querySelector(`#startOverlay button.diff[data-d="${preset.key}"]`).click();

    const overlay = document.getElementById('startOverlay');
    assert.ok(!overlay.classList.contains('show'), 'dialog stayed open after starting');
    assert.notEqual(
      document.querySelector('.app').inert,
      true,
      'background stayed inert after the dialog closed',
    );

    const cells = [...document.querySelectorAll('#board .cell')];
    const givens = cells.filter((c) => c.classList.contains('given'));
    assert.equal(givens.length, preset.clues, 'wrong number of clues on the board');

    assert.equal(
      document.getElementById('remaining').textContent.trim(),
      `${81 - preset.clues} por llenar`,
    );
    assert.equal(document.getElementById('diffLabel').textContent.trim(), preset.label);

    assert.deepEqual(errors, []);
    dom.window.close();
  });
}

test('pausing hides the board from assistive tech, not just from sight', () => {
  const { window, document, errors, dom } = boot();

  document.querySelector('#startOverlay button.diff[data-d="medium"]').click();

  const veil = document.getElementById('veil');
  const board = document.getElementById('board');
  const controls = document.querySelector('.controls');

  assert.equal(veil.getAttribute('role'), 'dialog');
  assert.equal(veil.getAttribute('aria-modal'), 'true');
  assert.ok(veil.getAttribute('aria-labelledby'), 'pause dialog has no accessible name');

  document.getElementById('pauseBtn').click();

  /* The regression: .board.veiled only sets color:transparent, so without
     inert every solved value stayed readable and every cell stayed tabbable. */
  assert.ok(veil.classList.contains('show'), 'veil did not open');
  assert.equal(board.inert, true, 'board is reachable by assistive tech while paused');
  assert.equal(controls.inert, true, 'controls are reachable while paused');
  assert.equal(document.activeElement, document.getElementById('resumeBtn'));

  /* Escape resumes. */
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!veil.classList.contains('show'), 'Escape did not dismiss the pause veil');
  assert.notEqual(board.inert, true, 'board stayed inert after resuming');
  assert.notEqual(controls.inert, true, 'controls stayed inert after resuming');

  assert.deepEqual(errors, []);
  dom.window.close();
});

test('undo restores hint, mistake and given state', () => {
  const { window, document, errors, dom } = boot();

  document.querySelector('#startOverlay button.diff[data-d="medium"]').click();

  const press = (key) =>
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));

  const cells = [...document.querySelectorAll('#board .cell')];
  const index = cells.findIndex((c) => c.classList.contains('sel'));
  assert.ok(index >= 0, 'no cell is selected after starting');
  const cell = cells[index];

  /* Hint fills the cell and marks it given; undo must roll both back, or the
     cell stays locked holding a value the player can no longer edit. */
  press('h');
  assert.equal(document.getElementById('hints').textContent.trim(), '1');
  assert.ok(cell.classList.contains('given'), 'hint did not mark the cell given');
  const hinted = cell.firstChild.textContent.trim();
  assert.match(hinted, /^[1-9]$/);

  press('z');
  assert.equal(document.getElementById('hints').textContent.trim(), '0', 'hints not restored');
  assert.ok(!cell.classList.contains('given'), 'cell stayed locked as a given after undo');
  assert.equal(cell.firstChild.textContent.trim(), '', 'value not cleared by undo');

  /* A wrong entry must not strand the mistake counter, which gates the bonus. */
  const wrong = String((Number(hinted) % 9) + 1);
  press(wrong);
  assert.equal(document.getElementById('mistakes').textContent.trim(), '1');
  press('z');
  assert.equal(document.getElementById('mistakes').textContent.trim(), '0', 'mistakes not restored');

  assert.deepEqual(errors, []);
  dom.window.close();
});
