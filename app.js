const GENERATOR_URL = './generator.js';
const GENERATOR_TIMEOUT = 10000;
let genWorker = null,
  genJobs = new Map(),
  genNextId = 1,
  genScript = null;

function generatorWorker() {
  if (genWorker !== null) return genWorker;
  try {
    const worker = new Worker(GENERATOR_URL);
    worker.addEventListener('message', (e) => {
      const reply = e.data || {};
      const job = genJobs.get(reply.id);
      if (!job) return;
      genJobs.delete(reply.id);
      if (reply.ok) job.resolve(reply);
      // MUST KILL: ranAndFailed is an untyped flag on an Error, so the retry rule in requestPuzzle reads as a guess.
      else
        job.reject(
          Object.assign(new Error(reply.error || 'the generator failed'), { ranAndFailed: true }),
        );
    });
    worker.addEventListener('error', () => {
      genWorker = false;
      for (const job of genJobs.values()) job.reject(new Error('the generator worker stopped'));
      genJobs.clear();
    });
    genWorker = worker;
  } catch {
    genWorker = false;
  }
  return genWorker;
}

function loadGeneratorScript() {
  if (genScript !== null) return genScript;
  genScript = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GENERATOR_URL;
    el.addEventListener('load', resolve);
    el.addEventListener('error', () => {
      el.remove();
      genScript = null;
      reject(new Error(`could not load ${GENERATOR_URL}`));
    });
    document.head.append(el);
  });
  return genScript;
}

function generateOnThisThread(request) {
  return loadGeneratorScript().then(() => window.SudokuGenerator.makePuzzle(request));
}

function requestPuzzle(request) {
  const worker = generatorWorker();
  if (worker === false) return generateOnThisThread(request);
  const id = genNextId++;
  return new Promise((resolve, reject) => {
    genJobs.set(id, { resolve, reject });
    setTimeout(() => {
      if (!genJobs.has(id)) return;
      genJobs.delete(id);
      genWorker = false;
      reject(new Error('the generator worker did not answer'));
    }, GENERATOR_TIMEOUT);
    worker.postMessage({ clues: request.clues, grade: request.grade, seed: request.seed, id });
  }).catch((error) => {
    if (error?.ranAndFailed) throw error;
    return generateOnThisThread(request);
  });
}

// MUST KILL: DIFF is a plain object, so lookups by untrusted save data reach Object.prototype and every hasOwn guard exists only for that.
const DIFF = {
  easy: { clues: 40, grade: 1, label: 'Piola', fries: 5, choco: 1 },
  medium: { clues: 28, grade: 2, label: 'Normal', fries: 10, choco: 2 },
  hard: { clues: 32, grade: 3, label: 'Peludo', fries: 15, choco: 3 },
  expert: { clues: 24, grade: 4, label: 'Brígido', fries: 25, choco: 5 },
};
// MUST KILL: GRADE_WORDS is a hand copy of generator.js GRADE_NAMES read by bracket lookup; one shared table removes the copy and the guard.
const GRADE_WORDS = { 1: 'directas', 2: 'bloques', 3: 'pares', 4: 'avanzado' };
const GRADE_KEYS = {};
for (const key of Object.keys(DIFF)) GRADE_KEYS[DIFF[key].grade] = key;
const $ = (id) => document.getElementById(id);
const boardEl = $('board'),
  padEl = $('pad');

let solution = new Array(81).fill(0),
  fixed = new Array(81).fill(false),
  values = new Array(81).fill(0),
  puzzle = new Array(81).fill(0);
let notes = Array.from({ length: 81 }, () => new Set()),
  sel = -1;
let notesMode = false,
  mistakes = 0,
  hints = 0,
  seconds = 0,
  tick = null,
  paused = false,
  // MUST KILL: playing, solved and paused encode one game state across three booleans; a single state value makes the guard combinations unnecessary.
  solved = false,
  playing = false;
let wakeLock = null,
  wakeLockWanted = false,
  wakeLockPending = false;
// MUST KILL: revealed is left out of the save by omission and nothing in its name says so; a separate in-memory store would make that visible.
let revealed = new Set();
// MUST KILL: The announcement is split between a pending string and srLast; one announcer object would make the single-writer rule self-evident.
let srAction = '';
let undoStack = [],
  diffKey = 'medium',
  friesTotal = 0,
  chocoTotal = 0,
  // MUST KILL: Win timers are a bare array cleared in several places; a scheduler with one cancel() removes the need to remember every clear.
  winTimers = [],
  pausedByDialog = false;
let puzzleGrade = 1,
  puzzleSeed = 0;
// MUST KILL: A flag beside the grade and seed it qualifies; one record holding grade, seed and measured state would make the guess-or-measure rule a type.
let puzzleMeasured = false;
const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)');
// MUST KILL: SAVE_VERSION and the shape checks in loadGame() are kept by hand in two places; one schema definition would make the coupling self-evident.
const SAVE_KEY = 'sudoku:save',
  SAVE_VERSION = 1;
const WALLET_KEY = 'sudoku:wallet',
  WALLET_VERSION = 2;
const LEDGER_MAX = 40;
const STATS_KEY = 'sudoku:stats',
  STATS_VERSION = 1;
let ledger = [],
  stats = null;
const HISTORY_KEY = 'sudoku:history',
  HISTORY_VERSION = 1;
let games = [];
const PREFS_KEY = 'sudoku:prefs',
  PREFS_VERSION = 1;
let prefs = { buzz: true };

const cells = [];
for (let i = 0; i < 81; i++) {
  const b = document.createElement('button');
  b.className = 'cell';
  b.dataset.i = i;
  const v = document.createElement('span');
  v.className = 'v';
  const n = document.createElement('div');
  n.className = 'notes';
  for (let d = 1; d <= 9; d++) n.append(document.createElement('span'));
  b.append(v, n);
  b.addEventListener('click', () => {
    if (!playing || paused) return;
    sel = i;
    render();
    saveGame();
  });
  boardEl.append(b);
  cells.push(b);
}
const keys = [];
for (let d = 1; d <= 9; d++) {
  const k = document.createElement('button');
  k.className = 'key';
  k.innerHTML = `<span class="d">${d}</span><span class="c">9</span>`;
  k.addEventListener('click', () => inputDigit(d));
  padEl.append(k);
  keys.push(k);
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (s) =>
  s < 3600
    ? `${(s / 60) | 0}:${pad2(s % 60)}`
    : `${(s / 3600) | 0}:${pad2(((s / 60) | 0) % 60)}:${pad2(s % 60)}`;
const clockText = (s) => (s < 3600 ? `${pad2((s / 60) | 0)}:${pad2(s % 60)}` : fmt(s));
function snapshot() {
  undoStack.push({ values: values.slice(), fixed: fixed.slice(), notes: notes.map((s) => [...s]) });
  if (undoStack.length > 300) undoStack.shift();
}
// MUST KILL: boxOf is a top-level name duplicated with generator.js; scoping app.js or sharing one geometry module removes the collision.
const boxOf = (i) => ((((i / 9) | 0) / 3) | 0) * 3 + (((i % 9) / 3) | 0);
function peers(i) {
  const r = (i / 9) | 0,
    c = i % 9,
    b = boxOf(i),
    out = new Set();
  for (let k = 0; k < 81; k++) {
    if (k === i) continue;
    if (((k / 9) | 0) === r || k % 9 === c || boxOf(k) === b) out.add(k);
  }
  return out;
}
const PEERS = Array.from({ length: 81 }, (_, i) => peers(i));

const appEl = document.querySelector('.app');
const controlsEl = document.querySelector('.controls');
// MUST KILL: The overlays are siblings of .app, so each one is made inert by hand; nesting them under a shared inert root removes this loop.
const OVERLAYS = ['startOverlay', 'winOverlay', 'recordOverlay'];
function showOverlay(el) {
  el.classList.add('show');
  appEl.inert = true;
  for (const id of OVERLAYS) $(id).inert = $(id) !== el;
  const first =
    el.querySelector('[data-autofocus]') ||
    el.querySelector('button:not([hidden]):not([disabled])');
  if (first) first.focus();
}
function hideOverlay(el) {
  el.classList.remove('show');
  for (const id of OVERLAYS) $(id).inert = false;
  if (!OVERLAYS.some((id) => $(id).classList.contains('show'))) appEl.inert = false;
}

function dismissOnBackdrop(el, close) {
  let fromBackdrop = false;
  el.addEventListener('pointerdown', (e) => {
    fromBackdrop = e.target === el;
  });
  el.addEventListener('click', (e) => {
    if (fromBackdrop && e.target === el) close();
  });
}

function startTimer() {
  clearInterval(tick);
  tick = setInterval(() => {
    seconds++;
    $('time').textContent = clockText(seconds);
  }, 1000);
}
function setPaused(p) {
  if (!playing || solved) return;
  const veil = $('veil');
  const wasShown = veil.classList.contains('show');
  paused = p;
  veil.classList.toggle('show', p);
  boardEl.classList.toggle('veiled', p);
  $('pauseBtn')
    .querySelector('use')
    .setAttribute('href', p ? '#i-play_arrow' : '#i-pause');
  $('pauseBtn').setAttribute('aria-label', p ? 'Seguir' : 'Pausar');
  boardEl.inert = p;
  controlsEl.inert = p;
  $('hintBtn').inert = p;
  $('settleBtn').inert = p;
  if (p) {
    clearInterval(tick);
    saveGame();
    $('resumeBtn').focus();
  } else {
    startTimer();
    if (wasShown) $('pauseBtn').focus();
  }
  syncWakeLock();
}

function syncWakeLock() {
  if (!navigator.wakeLock?.request) return;
  wakeLockWanted = playing && !paused && !solved && !document.hidden;
  if (!wakeLockWanted) {
    const held = wakeLock;
    wakeLock = null;
    if (held) held.release().catch(() => {});
    return;
  }
  if (wakeLock || wakeLockPending) return;
  wakeLockPending = true;
  navigator.wakeLock
    .request('screen')
    .then((sentinel) => {
      wakeLockPending = false;
      if (!wakeLockWanted) {
        sentinel.release().catch(() => {});
        return;
      }
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    })
    .catch(() => {
      wakeLockPending = false;
    });
}

let generating = false;

function setGenerating(busy) {
  generating = busy;
  $('genStatus').textContent = busy ? 'Generando tablero...' : '';
  document.querySelectorAll('.diff').forEach((b) => {
    b.disabled = busy;
  });
  $('cancelNew').disabled = busy;
  $('recordBtn').disabled = busy;
}

async function newGame(key) {
  if (generating) return;
  winTimers.forEach(clearTimeout);
  winTimers = [];
  setGenerating(true);
  let made;
  try {
    const seed = (Math.random() * 4294967296) >>> 0;
    made = await requestPuzzle({ clues: DIFF[key].clues, grade: DIFF[key].grade, seed });
  } catch {
    made = null;
  }
  setGenerating(false);
  if (made === null) {
    $('genStatus').textContent = 'No se pudo armar el tablero. Prueba de nuevo.';
    return;
  }
  startGame(key, made);
}

function startGame(key, made) {
  diffKey = key;
  winTimers.forEach(clearTimeout);
  winTimers = [];
  document.querySelectorAll('.drop').forEach((f) => {
    f.remove();
  });
  const generated = made.puzzle;
  puzzle = generated;
  solution = made.solution;
  puzzleGrade = made.grade;
  puzzleSeed = made.seed;
  puzzleMeasured = true;
  recordPlayed(key);
  values = generated.slice();
  fixed = generated.map((v) => v !== 0);
  notes = Array.from({ length: 81 }, () => new Set());
  undoStack = [];
  mistakes = 0;
  hints = 0;
  seconds = 0;
  solved = false;
  playing = true;
  pausedByDialog = false;
  revealed = new Set();
  sel = values.indexOf(0);
  setNotes(false);
  paintWallet();
  $('diffLabel').textContent = DIFF[key].label;
  $('time').textContent = '00:00';
  $('stamp').classList.remove('show');
  $('srStatus').textContent = '';
  $('srAlert').textContent = '';
  hideOverlay($('startOverlay'));
  hideOverlay($('winOverlay'));
  setPaused(document.hidden);
  srLast = { mistakes: 0, hints: 0, remaining: null };
  render();
  clearSavedGame();
  saveGame();
}

// MUST KILL: The counters live in both globals and the save and must be merged on every write; a single store removes the merge.
function adoptCounters() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(SAVE_KEY));
  } catch {
    return;
  }
  if (!s || typeof s !== 'object' || s.v !== SAVE_VERSION) return;
  if (!Array.isArray(s.solution) || s.solution.join() !== solution.join()) return;
  mistakes = Math.max(mistakes, count(s.mistakes));
  hints = Math.max(hints, count(s.hints));
}
function saveGame() {
  if (!playing || solved) return;
  syncWakeLock();
  adoptCounters();
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: SAVE_VERSION,
        puzzle,
        solution,
        values,
        fixed,
        notes: notes.map((s) => [...s]),
        sel,
        mistakes,
        hints,
        seconds,
        diffKey,
        solved,
        ...(puzzleMeasured ? { grade: puzzleGrade, seed: puzzleSeed } : {}),
      }),
    );
  } catch {}
}
let selSaveTimer = null;
function saveSelectionSoon() {
  clearTimeout(selSaveTimer);
  selSaveTimer = setTimeout(() => {
    selSaveTimer = null;
    saveGame();
  }, 250);
}
function clearSavedGame() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {}
}
function saveWallet() {
  try {
    localStorage.setItem(
      WALLET_KEY,
      JSON.stringify({ v: WALLET_VERSION, fries: friesTotal, choco: chocoTotal, ledger }),
    );
  } catch {}
}
function walletRaw() {
  try {
    return localStorage.getItem(WALLET_KEY);
  } catch {
    return null;
  }
}
function count(x) {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : 0;
}
function readEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.k !== 'win' && e.k !== 'redeem') return null;
  const t = Math.floor(Number(e.t));
  const f = Math.floor(Number(e.f));
  const c = Math.floor(Number(e.c));
  if (!Number.isFinite(t) || !Number.isFinite(f) || !Number.isFinite(c)) return null;
  const d = typeof e.d === 'string' && Object.hasOwn(DIFF, e.d) ? e.d : '';
  return { t, k: e.k, f, c, d };
}
function readWallet(raw = walletRaw()) {
  if (raw === null) return null;
  let w;
  try {
    w = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!w || typeof w !== 'object') return null;
  if (w.v !== WALLET_VERSION && w.v !== 1) return null;
  const entries = Array.isArray(w.ledger) ? w.ledger.map(readEntry).filter((e) => e !== null) : [];
  return { fries: count(w.fries), choco: count(w.choco), ledger: entries.slice(-LEDGER_MAX) };
}
function logEntry(base, entry) {
  return base.concat([entry]).slice(-LEDGER_MAX);
}
function bankPrize(fries, choco) {
  const raw = walletRaw();
  const stored = readWallet(raw);
  const base = stored || { fries: friesTotal, choco: chocoTotal, ledger };
  friesTotal = base.fries + fries;
  chocoTotal = base.choco + choco;
  ledger = logEntry(base.ledger, { t: Date.now(), k: 'win', f: fries, c: choco, d: diffKey });
  if (stored || raw === null) saveWallet();
}
function paintWallet() {
  $('fries').textContent = friesTotal;
  $('chocos').textContent = chocoTotal;
}
const chocoWord = (n) => `${n} chocolate${Math.abs(n) === 1 ? '' : 's'}`;
function chipSpan(emoji, n) {
  const span = document.createElement('span');
  span.className = 'chip';
  span.textContent = `${emoji} ${n > 0 ? '+' : ''}${n}`;
  return span;
}
function describeEntry(e) {
  const bits = [];
  if (e.f) bits.push(`${e.f > 0 ? '+' : ''}${e.f} papas`);
  if (e.c) bits.push(`${e.c > 0 ? '+' : ''}${chocoWord(e.c)}`);
  const what = bits.join(', ');
  if (e.k === 'redeem') return `${what} canjeadas`;
  return `${what}${e.d ? ` en ${DIFF[e.d].label}` : ''}`;
}
function progressLine(here) {
  if (here.verdict === 'few') return 'Todavía no se nota si el ritmo cambió.';
  if (here.verdict === 'better') return `Vas ${here.pct}% más rápido.`;
  if (here.verdict === 'worse') return 'Vas más lento que antes. Nada grave, pasa.';
  if (here.verdict === 'layoff')
    return `Volviste después de ${here.layoffDays} días. El ritmo se acomoda solo.`;
  return 'Vas parejo.';
}
function cleanRunLine(run) {
  if (run === 1) return 'La última te salió sin errores ni pistas.';
  return `Llevas ${run} partidas seguidas sin errores ni pistas.`;
}
function paintRecord() {
  const rows = $('recordRows');
  rows.textContent = '';
  let played = 0,
    won = 0;
  for (const key of Object.keys(DIFF)) {
    const row = stats.d[key];
    played += row.played;
    won += row.won;
    const tr = document.createElement('tr');
    for (const text of [
      DIFF[key].label,
      String(row.played),
      String(row.won),
      row.won ? fmt(row.best) : '',
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    rows.append(tr);
  }
  const noGames = played === 0 && won === 0;
  $('streakNow').textContent = stats.streak;
  $('streakNowWord').textContent = stats.streak === 1 ? 'seguida' : 'seguidas';
  $('streakBest').textContent = stats.bestStreak;
  $('streakCounts').hidden = noGames;
  $('streakText').classList.toggle('visually-hidden', !noGames);
  $('streakText').textContent = noGames
    ? 'Sin partidas todavía.'
    : `Racha de secas: ${stats.streak}. La mejor: ${stats.bestStreak}.`;

  const view = SudokuStats.report(games);
  const here = view.top ? view.grades[view.top] : null;
  const enough = here !== null && here.median !== null;
  $('progressBox').hidden = !enough;
  if (enough) {
    $('progressLevel').textContent = DIFF[GRADE_KEYS[view.top]].label;
    $('progressLede').textContent = progressLine(here);
    $('progressMedian').textContent = fmt(here.median);
    $('progressP25').textContent = fmt(here.p25);
    $('progressP75').textContent = fmt(here.p75);
    $('progressP90').textContent = fmt(here.p90);
    $('progressClean').hidden = here.run === 0;
    if (here.run > 0) $('progressClean').textContent = cleanRunLine(here.run);
  }
  $('progressOffer').hidden = view.offer === null;
  if (view.offer) {
    $('progressOffer').textContent =
      `Ya te queda chico. Prueba con ${DIFF[GRADE_KEYS[view.offer.to]].label}.`;
  }

  $('purseFries').textContent = friesTotal;
  $('purseChoco').textContent = chocoTotal;
  $('redeemFries').disabled = friesTotal <= 0;
  $('redeemChoco').disabled = chocoTotal <= 0;

  const list = $('ledgerList');
  list.textContent = '';
  for (const e of ledger.slice().reverse()) {
    const li = document.createElement('li');
    const what = document.createElement('span');
    const glyphs = document.createElement('span');
    glyphs.setAttribute('aria-hidden', 'true');
    if (e.f) glyphs.append(chipSpan('🍟', e.f));
    if (e.c) glyphs.append(chipSpan('🍫', e.c));
    const said = document.createElement('span');
    said.className = 'visually-hidden';
    said.textContent = describeEntry(e);
    what.append(glyphs, said);
    const when = document.createElement('time');
    const at = new Date(e.t);
    /* A timestamp out of Date's range is still a finite number, so this is
       checked rather than trusted: an invalid date renders as "Invalid Date". */
    if (!Number.isNaN(at.getTime())) {
      when.dateTime = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
      when.textContent = `${at.getDate()}/${at.getMonth() + 1}`;
    }
    li.append(what, when);
    list.append(li);
  }
}
function setNotes(on) {
  notesMode = on;
  $('penBtn').setAttribute('aria-checked', String(!on));
  $('notesBtn').setAttribute('aria-checked', String(on));
  $('penBtn').tabIndex = on ? -1 : 0;
  $('notesBtn').tabIndex = on ? 0 : -1;
  padEl.classList.toggle('noting', on);
}
function noteList(set) {
  if (set.size === 0) return '';
  const marks = [];
  for (let d = 1; d <= 9; d++) if (set.has(d)) marks.push(d);
  if (marks.length === 1) return `, nota ${marks[0]}`;
  return `, notas ${marks.slice(0, -1).join(', ')} y ${marks[marks.length - 1]}`;
}
/* Restarts the pop even if the chip is already mid-animation: removing the
   class is not enough on its own, the reflow between is what replays it. */
function popChip(id) {
  const chip = $(id);
  chip.classList.remove('pop');
  void chip.offsetWidth;
  chip.classList.add('pop');
}
function redeem(kind) {
  const raw = walletRaw();
  const stored = readWallet(raw);
  if (stored === null && raw !== null) return null;
  const base = stored || { fries: friesTotal, choco: chocoTotal, ledger };
  const choco = kind === 'choco';
  const amount = choco ? base.choco : base.fries;
  friesTotal = base.fries;
  chocoTotal = base.choco;
  ledger = base.ledger;
  if (amount <= 0) return 0;
  if (choco) chocoTotal = 0;
  else friesTotal = 0;
  ledger = logEntry(base.ledger, {
    t: Date.now(),
    k: 'redeem',
    f: choco ? 0 : -amount,
    c: choco ? -amount : 0,
    d: '',
  });
  saveWallet();
  return amount;
}

function blankStats() {
  const rows = {};
  for (const key of Object.keys(DIFF)) rows[key] = { played: 0, won: 0, best: 0 };
  return { v: STATS_VERSION, d: rows, streak: 0, bestStreak: 0 };
}
function readStats() {
  let raw;
  try {
    raw = localStorage.getItem(STATS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || s.v !== STATS_VERSION) return null;
  const blank = blankStats();
  const rows = s.d && typeof s.d === 'object' ? s.d : {};
  for (const key of Object.keys(blank.d)) {
    const row = rows[key] && typeof rows[key] === 'object' ? rows[key] : {};
    const won = count(row.won);
    blank.d[key] = { played: Math.max(count(row.played), won), won, best: count(row.best) };
  }
  blank.streak = count(s.streak);
  blank.bestStreak = Math.max(count(s.bestStreak), blank.streak);
  return blank;
}
function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {}
}
function loadStats() {
  stats = readStats() || blankStats();
}
function freshStats() {
  return readStats() || stats;
}
function recordPlayed(key) {
  stats = freshStats();
  stats.d[key].played++;
  saveStats();
}
const streakMilestone = (run) => run === 3 || (run >= 5 && run % 5 === 0);
const streakSaid = (run, record) =>
  record
    ? `¡Tu mejor racha: ${run} secas seguidas!`
    : run === 1
      ? 'Va 1 seca.'
      : `Van ${run} secas seguidas.`;
function recordWin(key, time, flawless) {
  stats = freshStats();
  const row = stats.d[key];
  const first = row.won === 0;
  const beat = !first && time < row.best;
  row.won++;
  if (first || time < row.best) row.best = time;
  const held = stats.bestStreak;
  stats.streak = flawless ? stats.streak + 1 : 0;
  if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
  saveStats();
  return {
    time: beat,
    streak: held > 0 && stats.bestStreak > held && streakMilestone(stats.streak),
  };
}

function readPrefs() {
  let raw;
  try {
    raw = localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object' || p.v !== PREFS_VERSION) return null;
  return { buzz: p.buzz !== false };
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, buzz: prefs.buzz }));
  } catch {}
}
function loadPrefs() {
  prefs = readPrefs() || { buzz: true };
}
const MISTAKE_BUZZ = [40, 30, 40];
function buzz(pattern) {
  if (!prefs.buzz || reduceMotion.matches || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {}
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ v: HISTORY_VERSION, games }));
  } catch {}
}
function historyRaw() {
  try {
    return localStorage.getItem(HISTORY_KEY);
  } catch {
    return null;
  }
}
function readHistory(raw = historyRaw()) {
  if (raw === null) return null;
  let h;
  try {
    h = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!h || typeof h !== 'object' || h.v !== HISTORY_VERSION) return null;
  return SudokuStats.readRows(h.games, Object.keys(DIFF));
}
function logGame(base, row) {
  return base.concat([row]).slice(-SudokuStats.HISTORY_MAX);
}
function recordGame(time, mist, used) {
  const raw = historyRaw();
  const stored = readHistory(raw);
  const base = stored || games;
  games = logGame(base, {
    t: Date.now(),
    s: time,
    m: mist,
    h: used,
    g: puzzleMeasured ? puzzleGrade : 0,
    d: diffKey,
  });
  if (stored || raw === null) saveHistory();
}
function loadHistory() {
  const stored = readHistory();
  if (stored) games = stored;
}

function loadWallet() {
  const raw = walletRaw();
  if (raw !== null) {
    const stored = readWallet(raw);
    if (stored) {
      friesTotal = stored.fries;
      chocoTotal = stored.choco;
      ledger = stored.ledger;
    }
    return;
  }
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    friesTotal = count(s && typeof s === 'object' && s.v === SAVE_VERSION ? s.friesTotal : 0);
  } catch {}
  if (friesTotal) saveWallet();
}
function loadGame() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!s || typeof s !== 'object' || s.v !== SAVE_VERSION) return false;
  const isGrid = (a) => Array.isArray(a) && a.length === 81;
  if (
    !isGrid(s.puzzle) ||
    !isGrid(s.solution) ||
    !isGrid(s.values) ||
    !isGrid(s.fixed) ||
    !Array.isArray(s.notes) ||
    s.notes.length !== 81
  )
    return false;
  if (!Object.hasOwn(DIFF, s.diffKey) || s.solved) return false;
  puzzle = s.puzzle.slice();
  solution = s.solution.slice();
  values = s.values.slice();
  fixed = s.fixed.slice();
  notes = s.notes.map((a) => new Set(Array.isArray(a) ? a : []));
  sel = Number.isInteger(s.sel) && s.sel >= 0 && s.sel < 81 ? s.sel : -1;
  mistakes = count(s.mistakes);
  hints = count(s.hints);
  seconds = count(s.seconds);
  diffKey = s.diffKey;
  const graded = Object.hasOwn(GRADE_WORDS, s.grade);
  const seeded = Number.isInteger(s.seed) && s.seed >= 0;
  puzzleGrade = graded ? Number(s.grade) : DIFF[s.diffKey].grade;
  puzzleSeed = seeded ? s.seed : 0;
  puzzleMeasured = graded && seeded;
  solved = false;
  playing = true;
  pausedByDialog = false;
  undoStack = [];
  revealed = new Set();
  winTimers.forEach(clearTimeout);
  winTimers = [];
  setNotes(false);
  $('diffLabel').textContent = DIFF[diffKey].label;
  $('time').textContent = clockText(seconds);
  $('stamp').classList.remove('show');
  srLast = { mistakes, hints, remaining: null };
  render();
  setPaused(false);
  return true;
}

function rain(n, glyph) {
  const wrap = document.querySelector('.board-wrap');
  const w = wrap.clientWidth,
    h = wrap.clientHeight;
  for (let k = 0; k < n; k++) {
    const f = document.createElement('span');
    f.className = 'drop';
    f.textContent = glyph;
    const dur = 1.1 + Math.random() * 1.2,
      delay = Math.random() * 0.9;
    f.style.left = `${Math.random() * (w - 34)}px`;
    f.style.fontSize = `${20 + Math.random() * 15}px`;
    f.style.setProperty('--dur', `${dur}s`);
    f.style.setProperty('--delay', `${delay}s`);
    f.style.setProperty('--fall', `${h + 100}px`);
    f.style.setProperty('--spin', `${((Math.random() * 720) | 0) - 360}deg`);
    f.addEventListener('animationend', () => f.remove());
    setTimeout(() => f.remove(), (dur + delay) * 1000 + 500);
    wrap.append(f);
  }
}

function win() {
  solved = true;
  playing = false;
  clearSavedGame();
  clearInterval(tick);
  syncWakeLock();
  sel = -1;
  render();
  $('stamp').classList.add('show');
  const flawless = mistakes === 0 && hints === 0;
  const earned = DIFF[diffKey].fries * (flawless ? 2 : 1);
  const chocoEarned = flawless ? DIFF[diffKey].choco : 0;
  const finalTime = seconds,
    finalMist = mistakes,
    finalHints = hints;
  bankPrize(earned, chocoEarned);
  const broke = recordWin(diffKey, finalTime, flawless);
  const beatBest = broke.time,
    beatStreak = broke.streak;
  recordGame(finalTime, finalMist, finalHints);
  const streakNow = stats.streak;
  $('srAlert').textContent =
    `Ganaste. ${fmt(seconds)}, ${mistakes === 1 ? '1 error' : `${mistakes} errores`}, ${hints === 1 ? '1 pista' : `${hints} pistas`}.` +
    ` Te llevas ${earned} papas fritas${chocoEarned ? ` y ${chocoWord(chocoEarned)}` : ''}.` +
    (beatBest ? ' ¡Nuevo récord de tiempo!' : '') +
    (flawless ? ` ${streakSaid(streakNow, beatStreak)}` : '');
  const slow = reduceMotion.matches ? 0 : 1;
  if (!reduceMotion.matches) {
    winTimers.push(setTimeout(() => rain(Math.min(earned, 30), '🍟'), 450));
    if (chocoEarned) winTimers.push(setTimeout(() => rain(chocoEarned, '🍫'), 700));
    if (beatBest) winTimers.push(setTimeout(() => rain(6, '🏆'), 950));
    if (beatStreak) winTimers.push(setTimeout(() => rain(6, '🥇'), 1150));
  }
  winTimers.push(
    setTimeout(() => {
      paintWallet();
      popChip('frychip');
      if (chocoEarned) popChip('chocochip');
    }, 950 * slow),
  );
  winTimers.push(
    setTimeout(() => {
      $('wTime').textContent = fmt(finalTime);
      $('wMist').textContent = finalMist;
      $('wHint').textContent = finalHints;
      $('winLede').textContent = flawless
        ? 'La más seca: cero errores, cero pistas.'
        : finalMist === 0
          ? 'Sin errores. Filete.'
          : 'Costó, pero salió igual.';
      $('wBestLine').hidden = !beatBest;
      $('wTimeStat').classList.toggle('record', beatBest);
      $('wStreakLine').hidden = !flawless;
      if (flawless) {
        $('wStreakGlyph').textContent = beatStreak ? '🥇' : '🔥';
        $('wStreakText').textContent = streakSaid(streakNow, beatStreak);
      }
      $('wCodeLine').hidden = !puzzleMeasured;
      if (puzzleMeasured) {
        $('wGrade').textContent = GRADE_WORDS[puzzleGrade];
        $('wCode').textContent = puzzleSeed.toString(36);
      }
      $('fryBanner').innerHTML =
        `<b aria-hidden="true">🍟 +${earned}</b>` +
        (chocoEarned ? `<b aria-hidden="true">🍫 +${chocoEarned}</b>` : '') +
        `<span class="visually-hidden">Ganaste ${earned} papas fritas${chocoEarned ? ` y ${chocoWord(chocoEarned)}` : ''}.</span>`;
      showOverlay($('winOverlay'));
    }, 1900 * slow),
  );
}

function inputDigit(d) {
  if (!playing || paused || sel < 0 || fixed[sel]) return;
  if (notesMode && values[sel] !== 0) return;
  if (!notesMode && values[sel] === d) return;
  snapshot();
  if (notesMode) {
    if (notes[sel].has(d)) {
      notes[sel].delete(d);
    } else {
      notes[sel].add(d);
    }
  } else {
    values[sel] = d;
    notes[sel].clear();
    if (d === solution[sel]) {
      for (const p of PEERS[sel]) notes[p].delete(d);
    } else {
      mistakes++;
      buzz(MISTAKE_BUZZ);
    }
  }
  render();
  saveGame();
  if (values.every((v, i) => v === solution[i])) win();
}
function erase() {
  if (!playing || paused || sel < 0 || fixed[sel]) return;
  if (values[sel] === 0 && notes[sel].size === 0) return;
  snapshot();
  values[sel] = 0;
  notes[sel].clear();
  render();
  saveGame();
}
function undo() {
  if (!playing || paused || undoStack.length === 0) return;
  const s = undoStack.pop();
  values = s.values;
  fixed = s.fixed;
  notes = s.notes.map((a) => new Set(a));
  srAction = 'Deshecho';
  render();
  saveGame();
}
function openDigits(i) {
  const taken = new Set();
  for (const p of PEERS[i]) if (values[p]) taken.add(values[p]);
  const open = [];
  for (let d = 1; d <= 9; d++) if (!taken.has(d)) open.push(d);
  return open;
}
function settledCells() {
  if (!values.every((v, i) => v === 0 || v === solution[i])) return [];
  const found = [];
  for (let i = 0; i < 81; i++) {
    if (values[i] !== 0 || fixed[i] || notes[i].size !== 1) continue;
    const open = openDigits(i);
    const [only] = notes[i];
    if (open.length === 1 && open[0] === only) found.push([i, only]);
  }
  return found;
}
function settleSingles() {
  if (!playing || paused) return;
  const found = settledCells();
  if (found.length === 0) return;
  snapshot();
  for (const [i, d] of found) {
    values[i] = d;
    notes[i].clear();
    for (const p of PEERS[i]) notes[p].delete(d);
  }
  srAction = found.length === 1 ? 'Confirmada 1 casilla' : `Confirmadas ${found.length} casillas`;
  render();
  saveGame();
  if (values.every((v, i) => v === solution[i])) win();
}
function easiestOpen() {
  let best = -1;
  let fewest = 10;
  for (let i = 0; i < 81; i++) {
    if (values[i] === solution[i]) continue;
    const taken = new Set();
    for (const p of PEERS[i]) if (values[p]) taken.add(values[p]);
    const candidates = 9 - taken.size;
    if (candidates < fewest) {
      fewest = candidates;
      best = i;
    }
  }
  return best;
}
function hint() {
  if (!playing || paused) return;
  let i = sel >= 0 && !fixed[sel] && values[sel] !== solution[sel] ? sel : -1;
  if (i < 0) {
    i = easiestOpen();
    if (i < 0) return;
    srAction = fixed[sel] ? 'Esa casilla ya viene dada, pista en otra' : 'Pista en otra casilla';
  }
  snapshot();
  values[i] = solution[i];
  fixed[i] = true;
  notes[i].clear();
  for (const p of PEERS[i]) notes[p].delete(solution[i]);
  if (!revealed.has(i)) {
    hints++;
    revealed.add(i);
  }
  sel = i;
  render();
  saveGame();
  if (values.every((v, k) => v === solution[k])) win();
}

let srLast = { mistakes: 0, hints: 0, remaining: null };
function render() {
  const selVal = sel >= 0 ? values[sel] : 0;
  const pr = sel >= 0 ? PEERS[sel] : null;
  let left = 0;
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 81; i++) {
    const v = values[i];
    if (v && v === solution[i]) counts[v]++;
    if (!v || v !== solution[i]) left++;
    const el = cells[i];
    el.firstChild.textContent = v || '';
    const ns = el.lastChild.children;
    for (let d = 1; d <= 9; d++) ns[d - 1].textContent = !v && notes[i].has(d) ? d : '';
    el.className =
      'cell' +
      (fixed[i] ? ' given' : '') +
      (v && v !== solution[i] ? ' wrong' : '') +
      (i === sel ? ' sel' : '') +
      (pr?.has(i) && i !== sel ? ' peer' : '') +
      (selVal && v === selVal && i !== sel ? ' same' : '');
    const r = ((i / 9) | 0) + 1,
      c = (i % 9) + 1;
    el.setAttribute(
      'aria-label',
      `Fila ${r}, columna ${c}${v ? `, ${v}` : ', vacía'}${fixed[i] ? ', dada' : ''}${
        v ? '' : noteList(notes[i])
      }`,
    );
  }
  for (let d = 1; d <= 9; d++) {
    keys[d - 1].querySelector('.c').textContent = Math.max(0, 9 - counts[d]);
    keys[d - 1].classList.toggle('done', counts[d] >= 9);
  }
  $('mistakes').textContent = mistakes;
  $('hints').textContent = hints;
  $('remaining').innerHTML = `<b>${left}</b> por llenar`;
  const settled = playing && !paused ? settledCells().length : 0;
  $('settleBtn').classList.toggle('idle', settled === 0);
  if (settled > 0) {
    $('settleCount').textContent = settled;
    $('settleBtn').setAttribute(
      'aria-label',
      settled === 1
        ? 'Confirmar 1 casilla que ya tiene una sola nota'
        : `Confirmar ${settled} casillas que ya tienen una sola nota`,
    );
  }
  if (playing) {
    const srBits = [];
    if (srAction) {
      srBits.push(srAction);
      srAction = '';
    }
    if (mistakes !== srLast.mistakes)
      srBits.push(mistakes === 1 ? '1 error' : `${mistakes} errores`);
    if (hints !== srLast.hints)
      srBits.push(hints === 1 ? '1 pista usada' : `${hints} pistas usadas`);
    if (
      left !== srLast.remaining &&
      (srLast.remaining === null || ((left / 10) | 0) !== ((srLast.remaining / 10) | 0))
    ) {
      srBits.push(left === 0 ? 'tablero completo' : `${left} celdas por llenar`);
    }
    if (srBits.length) {
      const said = `${srBits.join('. ')}.`;
      const node = $('srStatus');
      if (node.textContent === said) {
        node.textContent = '';
        setTimeout(() => {
          node.textContent = said;
        }, 0);
      } else node.textContent = said;
    }
    srLast = { mistakes, hints, remaining: left };
  }
}

$('pauseBtn').addEventListener('click', () => setPaused(!paused));
$('resumeBtn').addEventListener('click', () => setPaused(false));
$('penBtn').addEventListener('click', () => {
  if (playing && !paused) setNotes(false);
});
$('notesBtn').addEventListener('click', () => {
  if (playing && !paused) setNotes(true);
});
for (const id of ['penBtn', 'notesBtn']) {
  $(id).addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (!playing || paused) return;
    e.preventDefault();
    const next = notesMode ? 'penBtn' : 'notesBtn';
    setNotes(!notesMode);
    $(next).focus();
  });
}
$('eraseBtn').addEventListener('click', erase);
$('settleBtn').addEventListener('click', settleSingles);
$('undoBtn').addEventListener('click', undo);
$('hintBtn').addEventListener('click', hint);
$('newBtn').addEventListener('click', () => {
  winTimers.forEach(clearTimeout);
  winTimers = [];
  $('cancelNew').hidden = !playing;
  pausedByDialog = playing && !paused;
  if (pausedByDialog) setPaused(true);
  showOverlay($('startOverlay'));
});
$('cancelNew').addEventListener('click', () => {
  hideOverlay($('startOverlay'));
  if (pausedByDialog) setPaused(false);
  pausedByDialog = false;
  if (paused) $('resumeBtn').focus();
});
$('againBtn').addEventListener('click', () => {
  hideOverlay($('winOverlay'));
  $('cancelNew').hidden = true;
  showOverlay($('startOverlay'));
});

function openRecord() {
  paintRecord();
  showOverlay($('recordOverlay'));
}
$('recordBtn').addEventListener('click', openRecord);
$('veilRecordBtn').addEventListener('click', openRecord);
function closeRecord() {
  disarmRedeem();
  hideOverlay($('recordOverlay'));
  if ($('startOverlay').classList.contains('show')) $('recordBtn').focus();
  else if ($('veil').classList.contains('show')) $('veilRecordBtn').focus();
}
$('buzzToggle').addEventListener('change', (e) => {
  prefs.buzz = e.currentTarget.checked;
  savePrefs();
});
$('closeRecord').addEventListener('click', closeRecord);

dismissOnBackdrop($('recordOverlay'), closeRecord);
dismissOnBackdrop($('startOverlay'), () => {
  if (!$('cancelNew').hidden) $('cancelNew').click();
});
dismissOnBackdrop($('veil'), () => setPaused(false));

let armedPrize = null,
  armTimer = null;
function disarmRedeem() {
  clearTimeout(armTimer);
  armedPrize = null;
  for (const id of ['redeemFries', 'redeemChoco']) {
    $(id).classList.remove('arm');
    $(id).textContent = 'Canjear';
  }
}
document.querySelectorAll('.redeem').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.k;
    const word = kind === 'choco' ? 'chocolates' : 'papas fritas';
    if (armedPrize !== kind) {
      disarmRedeem();
      armedPrize = kind;
      button.classList.add('arm');
      button.textContent = '¿Seguro?';
      $('srStatus').textContent =
        `Toca de nuevo para canjear ${kind === 'choco' ? chocoTotal : friesTotal} ${word}.`;
      armTimer = setTimeout(disarmRedeem, 4000);
      return;
    }
    const amount = redeem(kind);
    disarmRedeem();
    $('closeRecord').focus();
    paintWallet();
    paintRecord();
    $('srStatus').textContent =
      amount === null
        ? `No se pudo canjear: hay premios guardados que esta versión no entiende.`
        : amount > 0
          ? `Canjeaste ${amount} ${word}.`
          : `No hay ${word} para canjear.`;
  });
});
document.querySelectorAll('.diff').forEach((b) => {
  const d = DIFF[b.dataset.d];
  b.innerHTML = `${d.label} <span>${GRADE_WORDS[d.grade]}</span>`;
  b.addEventListener('click', () => newGame(b.dataset.d));
});

document.addEventListener('keydown', (e) => {
  if (!e.key) return;
  const k = e.key.toLowerCase();
  if ($('recordOverlay').classList.contains('show')) {
    if (k === 'escape') closeRecord();
    return;
  }
  if ($('startOverlay').classList.contains('show')) {
    if (k === 'escape' && !$('cancelNew').hidden) $('cancelNew').click();
    return;
  }
  if ($('winOverlay').classList.contains('show')) return;
  if ((e.ctrlKey || e.metaKey || e.altKey) && k !== 'z') return;
  if (k === 'p') {
    setPaused(!paused);
    return;
  }
  if (k === 'escape' && paused) {
    setPaused(false);
    return;
  }
  if (!playing || paused) return;
  if (e.key >= '1' && e.key <= '9') {
    inputDigit(+e.key);
    return;
  }
  if (k === 'backspace' || k === 'delete' || e.key === '0') {
    e.preventDefault();
    erase();
  } else if (k === 'n') setNotes(!notesMode);
  else if (k === 'h') hint();
  else if (k === 'z') undo();
  else if (k.startsWith('arrow')) {
    e.preventDefault();
    if (sel < 0) {
      sel = 0;
      render();
      saveSelectionSoon();
      return;
    }
    const r = (sel / 9) | 0,
      c = sel % 9;
    if (k === 'arrowup' && r > 0) sel -= 9;
    if (k === 'arrowdown' && r < 8) sel += 9;
    if (k === 'arrowleft' && c > 0) sel -= 1;
    if (k === 'arrowright' && c < 8) sel += 1;
    render();
    saveSelectionSoon();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPaused(true);
  syncWakeLock();
});
addEventListener('storage', (e) => {
  if (e.key === STATS_KEY) {
    const s = readStats();
    if (s) {
      stats = s;
      paintRecord();
    }
    return;
  }
  if (e.key === HISTORY_KEY) {
    const h = readHistory();
    if (h) {
      games = h;
      paintRecord();
    }
    return;
  }
  if (e.key !== WALLET_KEY) return;
  const w = readWallet();
  if (!w) return;
  disarmRedeem();
  friesTotal = w.fries;
  chocoTotal = w.choco;
  ledger = w.ledger;
  paintWallet();
  paintRecord();
});

loadWallet();
loadStats();
loadHistory();
loadPrefs();
$('buzzToggle').checked = prefs.buzz;
paintWallet();
paintRecord();
if (!loadGame()) {
  render();
  $('cancelNew').hidden = true;
  showOverlay($('startOverlay'));
}
if ('serviceWorker' in navigator) {
  const wasControlled = !!navigator.serviceWorker.controller;
  let registration = null,
    nextCheckAt = 0,
    checking = false,
    reloading = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((r) => {
        registration = r;
      })
      .catch(() => {});
  });

  const CHECK_EVERY = 36e5,
    RETRY_AFTER = 6e4;
  function checkForUpdate() {
    if (registration === null || document.hidden || checking) return;
    if (navigator.onLine === false) return;
    if (Date.now() < nextCheckAt) return;
    checking = true;
    nextCheckAt = Date.now() + RETRY_AFTER;
    registration
      .update()
      .then(() => {
        nextCheckAt = Date.now() + CHECK_EVERY;
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  }
  document.addEventListener('visibilitychange', checkForUpdate);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) checkForUpdate();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    location.reload();
  });

  if (matchMedia('(display-mode: standalone)').matches && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
}
