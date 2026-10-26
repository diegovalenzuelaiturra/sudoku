(function (root) {
  const HISTORY_MAX = 120;
  const MAX_GRADE = 4;
  const MAX_SECONDS = 86400;
  const MIN_MEDIAN_N = 5;
  const MIN_TREND_N = 8;
  const TREND_WINDOW = 20;
  const WINSOR_FACTOR = 3;
  const WILSON_Z = 1.96;
  const TREND_BAND = 0.08;
  const NOISE_K = 0.5;
  const DECLINE_BAR = 1.5;
  const LAYOFF_MS = 12096e5;
  const STALE_MIN_N = 12;
  const STALE_RUN = 10;
  const STALE_FLAWLESS_LOW = 0.8;
  const MIN_LOG_SECONDS = 1;

  function readRow(raw, keys = []) {
    if (!raw || typeof raw !== 'object') return null;
    const t = Math.floor(Number(raw.t));
    if (!Number.isSafeInteger(t)) return null;
    const s = Math.floor(Number(raw.s));
    if (!Number.isSafeInteger(s) || s < 0 || s > MAX_SECONDS) return null;
    const m = Math.floor(Number(raw.m));
    if (!Number.isSafeInteger(m) || m < 0) return null;
    const h = Math.floor(Number(raw.h));
    if (!Number.isSafeInteger(h) || h < 0) return null;
    const measured = Math.floor(Number(raw.g));
    // MUST KILL: grade 0 is an unmeasured sentinel shared with real numbers; a null grade makes the held-out rule explicit
    const g =
      Number.isSafeInteger(measured) && measured >= 1 && measured <= MAX_GRADE ? measured : 0;
    const d = typeof raw.d === 'string' && keys.includes(raw.d) ? raw.d : '';
    return { t, s, m, h, g, d };
  }

  function readRows(list, keys = []) {
    if (!Array.isArray(list)) return [];
    const rows = list.map((raw) => readRow(raw, keys)).filter((row) => row !== null);
    return rows.slice(-HISTORY_MAX);
  }

  const isFlawless = (row) => row.m === 0 && row.h === 0;

  function cleanRun(rows) {
    let run = 0;
    for (let i = rows.length - 1; i >= 0 && isFlawless(rows[i]); i--) run++;
    return run;
  }

  function ascending(values) {
    const out = values.slice();
    out.sort((a, b) => a - b);
    return out;
  }

  function quantile(sorted, p) {
    const n = sorted.length;
    if (n === 0) return null;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * Math.min(Math.max(p, 0), 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function summarize(times) {
    const n = times.length;
    if (n < MIN_MEDIAN_N) return { n, median: null, p25: null, p75: null, p90: null };
    const sorted = ascending(times);
    return {
      n,
      median: Math.round(quantile(sorted, 0.5)),
      p25: Math.round(quantile(sorted, 0.25)),
      p75: Math.round(quantile(sorted, 0.75)),
      p90: Math.round(quantile(sorted, 0.9)),
    };
  }

  // MUST KILL: wilson accepts any count and clamps it; taking the rows instead of two numbers makes successes at most n by construction
  function wilson(successes, n) {
    if (!Number.isFinite(n) || n <= 0) return { n: 0, rate: null, low: null, high: null };
    const k = Math.min(Math.max(successes, 0), n);
    const p = k / n;
    const z2 = WILSON_Z * WILSON_Z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const margin = (WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
    return {
      n,
      rate: p,
      low: k === 0 ? 0 : Math.max(0, centre - margin),
      high: k === n ? 1 : Math.min(1, centre + margin),
    };
  }

  function winsorize(times, factor = WINSOR_FACTOR) {
    const mid = quantile(ascending(times), 0.5);
    if (mid === null) return [];
    const cap = Math.max(mid, MIN_LOG_SECONDS) * factor;
    return times.map((v) => (v > cap ? cap : v));
  }

  const toLog = (times) => times.map((v) => Math.log(Math.max(v, MIN_LOG_SECONDS)));

  function logSlope(logValues) {
    const n = logValues.length;
    if (n < 2) return 0;
    const slopes = [];
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) slopes.push((logValues[j] - logValues[i]) / (j - i));
    }
    slopes.sort((a, b) => a - b);
    return quantile(slopes, 0.5);
  }

  function trend(times) {
    const n = times.length;
    if (n < MIN_TREND_N) return { n, verdict: 'few', change: 0, ratio: 1 };
    const logs = toLog(winsorize(times, WINSOR_FACTOR));
    const sorted = ascending(logs);
    const change = logSlope(logs) * (n - 1);
    const spread = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const floor = Math.max(TREND_BAND, NOISE_K * spread);
    const ratio = Math.exp(change);
    if (change <= -floor) return { n, verdict: 'better', change, ratio };
    if (change >= floor * DECLINE_BAR) return { n, verdict: 'worse', change, ratio };
    return { n, verdict: 'same', change, ratio };
  }

  function verdict(times) {
    const now = trend(times.slice(-TREND_WINDOW));
    if (now.verdict === 'few') return now;
    const before = trend(times.slice(0, -1).slice(-TREND_WINDOW));
    if (before.verdict === now.verdict) return now;
    return { n: now.n, verdict: 'same', change: now.change, ratio: now.ratio };
  }

  function gradeReport(rowsAtGrade) {
    const times = rowsAtGrade.map((row) => row.s);
    const pace = summarize(times);
    const n = pace.n;
    const flawless = wilson(rowsAtGrade.filter(isFlawless).length, n);
    const call = verdict(times);
    const gap = n >= 2 ? rowsAtGrade[n - 1].t - rowsAtGrade[n - 2].t : 0;
    const layoff = gap >= LAYOFF_MS;
    return {
      n,
      median: pace.median,
      p25: pace.p25,
      p75: pace.p75,
      p90: pace.p90,
      flawless,
      run: cleanRun(rowsAtGrade),
      verdict: layoff && call.verdict === 'worse' ? 'layoff' : call.verdict,
      ratio: call.ratio,
      pct: Math.round(Math.abs(1 - call.ratio) * 100),
      layoffDays: layoff ? Math.floor(gap / 864e5) : 0,
    };
  }

  function staleOffer(grades, measured, top) {
    if (top < 1 || top >= MAX_GRADE) return null;
    const here = grades[top];
    if (here.n < STALE_MIN_N) return null;
    if (here.verdict !== 'same') return null;
    const run = measured.slice(-STALE_RUN);
    if (run.length < STALE_RUN || !run.every((row) => row.g === top)) return null;
    if (here.flawless.low === null || here.flawless.low < STALE_FLAWLESS_LOW) return null;
    return { from: top, to: top + 1 };
  }

  function topGrade(grades, measured) {
    if (measured.length === 0) return 0;
    for (let i = measured.length - 1; i >= 0; i--) {
      if (grades[measured[i].g].n >= MIN_MEDIAN_N) return measured[i].g;
    }
    return measured[measured.length - 1].g;
  }

  function report(rows) {
    const measured = rows.filter((row) => row.g >= 1);
    const grades = {};
    for (let g = 1; g <= MAX_GRADE; g++) {
      grades[g] = gradeReport(measured.filter((row) => row.g === g));
    }
    const top = topGrade(grades, measured);
    return {
      n: rows.length,
      measured: measured.length,
      grades,
      top,
      offer: staleOffer(grades, measured, top),
    };
  }

  root.SudokuStats = {
    HISTORY_MAX,
    MAX_GRADE,
    MAX_SECONDS,
    MIN_MEDIAN_N,
    MIN_TREND_N,
    TREND_WINDOW,
    WINSOR_FACTOR,
    WILSON_Z,
    TREND_BAND,
    NOISE_K,
    DECLINE_BAR,
    LAYOFF_MS,
    STALE_MIN_N,
    STALE_RUN,
    STALE_FLAWLESS_LOW,
    readRow,
    readRows,
    isFlawless,
    cleanRun,
    quantile,
    summarize,
    wilson,
    winsorize,
    toLog,
    logSlope,
    trend,
    verdict,
    gradeReport,
    report,
  };
})(typeof self !== 'undefined' ? self : globalThis);
