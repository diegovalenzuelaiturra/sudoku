/* Statistics over finished games, computed at read time from the rows handed in.

   sudoku:stats keeps lifetime counters and one best time per difficulty. A best
   time is a max of n record: it moves in one direction only, so it cannot show
   a decline, and it saturates once the easy gains are spent. The rows this file
   reads are what answer "am I improving, stale, or getting worse", and keeping
   raw rows lets a later build compute a number nobody has asked for yet with no
   storage migration.

   Nothing here touches the DOM, storage, the clock or a random source. Time
   arrives as the `t` field of a row, the difficulty keys arrive as an argument,
   and every function is total: garbage in gives a well formed object out. The
   rows come from localStorage, which anything on this origin can write.

   Classic script, for the reason generator.js is one: the build folds this file
   into the page beside app.js, where two top level bindings of one name is a
   SyntaxError. One name is exported, and it is the only one this file adds. */
(function (root) {
  /* ---- constants ---- */

  /* The ring covers four grades and a trend needs eight games at one of them, so
     a shorter ring leaves a player who spreads games across the ladder under the
     threshold at every level. At roughly 60 bytes a row this is about 7 KB
     against the 5 MB an origin gets, and the oldest row falls off the end. */
  const HISTORY_MAX = 120;
  /* The ladder in generator.js: directas, bloques, pares, avanzado. */
  const MAX_GRADE = 4;
  /* A stored `s` past one day is no solve time. The row is rejected, which costs
     one line of history; a clamp would invent a number and then average it. */
  const MAX_SECONDS = 86400;
  /* Four points put p25 and p75 on the two middle observations, where every new
     game moves both. Five is the floor for a median, a band and a clean rate. */
  const MIN_MEDIAN_N = 5;
  /* No claim about direction under eight games. */
  const MIN_TREND_N = 8;
  /* The trend reads the last twenty games at a grade. An unbounded window keeps
     reporting an improvement that finished months ago. */
  const TREND_WINDOW = 20;
  /* A game is capped at three times the player's median for that grade on its
     way into a trend. The auto pause on visibilitychange already removes the
     backgrounded tail; this covers the game where the player walked away with
     the tab visible. The stored row keeps the true value. */
  const WINSOR_FACTOR = 3;
  /* 95 percent. At six flawless wins out of six the normal approximation puts
     the whole interval on 1.0, claiming certainty from six games; Wilson answers
     0.61 to 1.0, which is what six games are worth. */
  const WILSON_Z = 1.96;
  /* The dead band, in natural log units, so an 8 percent modelled change end to
     end is the smallest thing that may be called a change at all. Most games
     differ from the last by noise, and a verdict that flips sign every game
     costs the player their trust in every other number in the dialog. */
  const TREND_BAND = 0.08;
  /* The noise floor: half the interquartile range of the log times in the same
     window. A change under that sits inside one game's ordinary spread. What is
     applied is Math.max(TREND_BAND, NOISE_K * spread). */
  const NOISE_K = 0.5;
  /* Slower has to clear one and a half times what faster clears. This is a
     leisure game, so a decline is spoken only when it is loud. */
  const DECLINE_BAR = 1.5;
  /* Fourteen days. A gap this long before the last game at a grade explains a
     slower time, and it lowers the bar the player is being held to. */
  const LAYOFF_MS = 12096e5;
  /* Under twelve games at a grade nothing is stale, it is new. */
  const STALE_MIN_N = 12;
  /* The difficulty mix has stopped moving when the last ten measured games all
     sit at one grade. */
  const STALE_RUN = 10;
  /* Saturation is read off the Wilson lower bound. Three flawless wins out of
     three have a rate of 1.0 and a lower bound of 0.44, and saturate nothing.
     Clearing 0.8 takes sixteen flawless games in a row. */
  const STALE_FLAWLESS_LOW = 0.8;
  /* The floor under a time on its way into a logarithm. Math.log(0) is
     -Infinity, which poisons every mean and quantile downstream, and a zero
     second win is a real value this code base has already had a bug about. */
  const MIN_LOG_SECONDS = 1;

  /* ---- rows ---- */

  /* One stored row, or null. Every field is validated here because 0 is legal
     for `s`, `m` and `h`: a clamp that folds 0, a negative and NaN onto 0 cannot
     tell a real zero second win from a field somebody typed into the storage
     inspector.

     `t` is signed, because a clock can be set to anything and a row from a
     machine whose date was wrong is still a game that was played. `keys` is the
     difficulty table's own keys, passed in by the caller, so this file never
     learns what the difficulties are called. */
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
    /* A grade this build cannot place becomes 0, meaning "not measured", and the
       row survives. It still counts as a game played; it is only held out of the
       statistics that stratify on grade, where filing it under a guess would put
       one difficulty's times into another difficulty's median. */
    const measured = Math.floor(Number(raw.g));
    const g =
      Number.isSafeInteger(measured) && measured >= 1 && measured <= MAX_GRADE ? measured : 0;
    const d = typeof raw.d === 'string' && keys.includes(raw.d) ? raw.d : '';
    return { t, s, m, h, g, d };
  }

  /* Chronological, oldest first, trimmed to the ring length. Order is what the
     trend reads, so nothing here sorts. */
  function readRows(list, keys = []) {
    if (!Array.isArray(list)) return [];
    const rows = list.map((raw) => readRow(raw, keys)).filter((row) => row !== null);
    return rows.slice(-HISTORY_MAX);
  }

  /* No flawless flag is stored. It is derived from the two counters that decide
     the prize, so a row and the payout it earned cannot disagree. */
  const isFlawless = (row) => row.m === 0 && row.h === 0;

  /* ---- quantiles ---- */

  /* unicorn/no-array-sort reports a sort on an expression, and toSorted is
     Safari 16.4 against a 15.4 floor. Sorting a named local in statement
     position satisfies both, so every sort in this file comes through here. */
  function ascending(values) {
    const out = values.slice();
    out.sort((a, b) => a - b);
    return out;
  }

  /* Linear interpolation between order statistics, the type 7 definition, over
     an already ascending series. There is no division in it, so a series of
     identical values and a series of zeros are both safe. An empty series
     answers null: NaN renders as the string "NaN" and gets written back. */
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

  /* The headline centre and the band around it. Solve times are right skewed and
     roughly lognormal: a hard floor set by typing speed, and a long right tail
     from one stuck cell. The mean of such a sample is dragged by the tail and
     lands above most of the games actually played, so the headline is the
     median, which sits where half the games sit.

     The band is the interquartile range. Two standard deviations of raw time is
     the wrong tool on a skewed distribution: the lower edge is frequently a
     negative, that is, an impossible, time, and the band overstates the fast
     side while understating the slow side. The upper end is p90, which the copy
     frames as a promise the player nearly always keeps.

     Rounded to whole seconds, because the caller formats mm:ss and a fractional
     interpolation renders as 5:23.5. The small sample gate lives here so no
     caller can forget it. */
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

  /* ---- proportions ---- */

  /* The Wilson score interval for a rate. The normal approximation collapses at
     the ends: at 6 of 6 it gives plus or minus zero, and at 0 of 5 it gives a
     point estimate of zero with no width, both of which claim certainty a
     handful of games cannot buy. Wilson answers 0.61 to 1.0 and 0 to 0.43.

     n of zero answers nulls, so no division happens. The clamp on `successes` is
     load bearing: a stored count above n makes p greater than 1, p * (1 - p)
     then goes negative, and the square root of that is NaN.

     The ends are taken from the count. In exact arithmetic k of k puts the upper
     bound on 1 and 0 of n puts the lower bound on 0, and the two divisions below
     land within one ulp of that on either side: 6 of 6 computes an upper bound
     of 0.9999999999999999 and 0 of 119 a lower bound of 3.5e-18. */
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

  /* ---- trend ---- */

  /* A single interrupted game is a real number that describes nothing about
     skill, and one of them at the end of a window drags a slope hard. The cap is
     applied on the way into a trend and never on the way into a stored row: the
     row is the record of what happened, and the trend is a model of it.

     Order is preserved, because the trend reads position as time. Flooring the
     median at one second is what keeps a series whose median is 0 from
     collapsing every value onto 0. */
  function winsorize(times, factor = WINSOR_FACTOR) {
    const mid = quantile(ascending(times), 0.5);
    if (mid === null) return [];
    const cap = Math.max(mid, MIN_LOG_SECONDS) * factor;
    return times.map((v) => (v > cap ? cap : v));
  }

  /* Anything parametric belongs in log time, where a difference is a ratio and a
     mean is a geometric mean, which is what a multiplicative spread wants. */
  const toLog = (times) => times.map((v) => Math.log(Math.max(v, MIN_LOG_SECONDS)));

  /* Theil-Sen: the median of every pairwise slope over the points (index, value).
     A least squares fit lets one 5000 second game set the direction of the whole
     window, and that game records an interruption. Half the points can be
     garbage before the median slope moves. j - i is never zero, so there is no
     division by zero. Fewer than two points answers 0, so the caller multiplies
     with no branch. */
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

  /* One evaluation over exactly the series handed in, with no windowing of its
     own. `change` is the modelled change in log seconds across the whole series,
     negative for faster, and `ratio` is that as a multiplier of the first game.

     The threshold is the larger of a fixed relative band and half the window's
     own interquartile spread, so a player whose times scatter widely needs a
     bigger move before anything is said. Slower has to clear DECLINE_BAR times
     that. "same" is the resting answer and it is the honest one most weeks. */
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

  /* The spoken verdict, with hysteresis: the evaluation at the last game and the
     evaluation at the game before it have to agree before anything other than
     "same" is said, so one game cannot flip the sentence in the dialog.

     Both evaluations are recomputed from the stored rows, so no extra state is
     persisted, the whole thing stays a pure function a unit test can pin, and a
     player who clears one tab's memory sees the same answer as the other tab.

     This is the only place TREND_WINDOW is applied. `n` in the answer is the
     window length, at most TREND_WINDOW, and not the number of games at the
     grade. At exactly MIN_TREND_N games the earlier window holds one fewer and
     answers "few", which agrees with nothing, so the earliest a direction can be
     spoken is one game after that. */
  function verdict(times) {
    const now = trend(times.slice(-TREND_WINDOW));
    if (now.verdict === 'few') return now;
    const before = trend(times.slice(0, -1).slice(-TREND_WINDOW));
    if (before.verdict === now.verdict) return now;
    return { n: now.n, verdict: 'same', change: now.change, ratio: now.ratio };
  }

  /* ---- reports ---- */

  /* Everything the dialog says about one grade, from that grade's rows in
     chronological order. Times are never pooled across difficulty: a player who
     improves inside every level while drifting toward harder boards shows a
     rising pooled average, which is the opposite of what happened.

     A layoff overrides "worse" and nothing else. Fourteen days away explains a
     slower time, so it lowers the bar and the copy says so. Good news is never
     overridden by an excuse. A gap of zero or less is what a clock moved
     backwards produces, and it is never a layoff. */
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
      verdict: layoff && call.verdict === 'worse' ? 'layoff' : call.verdict,
      ratio: call.ratio,
      pct: Math.round(Math.abs(1 - call.ratio) * 100),
      layoffDays: layoff ? Math.floor(gap / 864e5) : 0,
    };
  }

  /* The invitation up the ladder, or null. Stale means three things at once: the
     estimate is flat, the difficulty mix has stopped moving, and the flawless
     rate has saturated at this level. That is the cue for the game to offer the
     next tier, which pays more and whose techniques are the next lesson in the
     generator's ladder. It reads every grade, so it lives beside `report`.

     Saturation is read off the Wilson lower bound, which takes sixteen flawless
     games in a row to clear 0.8. A rate of 1.0 on its own would fire this on a
     lucky three. */
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

  /* The grade one sentence is written about: the most recent one that already
     has games enough to say anything, and the grade of the last measured row
     when no grade has. The generator misses the tier it was asked for on about
     one Peludo board in seven, so reading the last row's grade straight let a
     single off target board carry the whole block onto a level the player has
     one game at, where every number in it is null and the dialog goes blank for
     a board they never chose. Games enough is the same floor a median needs, so
     the level that is named is always a level with numbers under it. */
  function topGrade(grades, measured) {
    if (measured.length === 0) return 0;
    for (let i = measured.length - 1; i >= 0; i--) {
      if (grades[measured[i].g].n >= MIN_MEDIAN_N) return measured[i].g;
    }
    return measured[measured.length - 1].g;
  }

  /* Every grade, always, plus the one the dialog is being asked about. Grades are
     stratified on the grade a board was measured at: the generator is allowed to
     miss the tier it was asked for, and the honest denominator is what the board
     turned out to be.

     Nothing in here throws on an empty ring. The caller paints this dialog at
     boot, before the saved game is restored, so anything thrown here would cost
     the player the board they left unfinished. */
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
