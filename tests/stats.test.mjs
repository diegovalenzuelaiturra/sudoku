/* Pins the statistics engine by loading stats.js itself, the way
   tests/generator.test.mjs loads generator.js, so the report a player reads is
   computed by the code these assertions drive. Requiring the file rather than
   evaluating it from a string is what gives it a real filename, so it counts
   toward the coverage floor npm run test:coverage enforces.

   Every number below was measured by running this build, and it is written down
   as the number rather than as a range wide enough to never mean anything. That
   is the same discipline the generator test gets from fixed seeds: a threshold
   that moves shows up here as a failure instead of as a quietly different
   sentence in the dialog. The thresholds are the whole feature. A verdict that
   flips sign on one game costs the player their trust in every other number the
   record shows, including the best times they currently believe.

   stats.js is a classic script that exports one name onto `self` where there is
   one and `globalThis` otherwise. Node has no `self`, so both files below leave
   a single name on the global object, which is read once and then deleted. The
   test runner gives every file its own process, so deleting SudokuGenerator
   here cannot race tests/generator.test.mjs doing the same. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

require(join(root, 'stats.js'));
const S = globalThis.SudokuStats;
delete globalThis.SudokuStats;

require(join(root, 'generator.js'));
const { GRADE_NAMES } = globalThis.SudokuGenerator;
delete globalThis.SudokuGenerator;

const DAY = 864e5;
const KEYS = ['easy', 'medium', 'hard', 'expert'];
/* One stored row. `i` doubles as the day it was played, so a series is
   chronological by construction and a gap can be opened by moving one `t`. */
const row = (i, s, g, extra = {}) => ({ t: i * DAY, s, m: 0, h: 0, g, d: 'easy', ...extra });
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));
/* A straight ramp in seconds, which is what a player who is getting faster or
   slower at a steady rate looks like. */
const ramp = (n, from, to, g = 1, extra = {}) =>
  series(n, (i) => row(i, Math.round(from + ((to - from) * i) / (n - 1)), g, extra));
const secondsOf = (rows) => rows.map((r) => r.s);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
/* Four decimals, which is the precision these numbers are quoted at in the
   comments inside stats.js and in the copy that reads them. */
const near = (x, y) => Math.abs(x - y) < 5e-5;

test('MAX_GRADE matches the ladder the generator grades against', () => {
  assert.equal(S.MAX_GRADE, Object.keys(GRADE_NAMES).length);
});

test('every threshold is the number it was chosen to be', () => {
  /* The tests below prove what each of these does. This one proves what each of
     them is, because the number itself is the decision: eight games before a
     direction is claimed, fourteen days before a slower run is a layoff, sixteen
     flawless wins before the offer to move up. A ring that quietly shrank or a
     cap that quietly moved would leave every one of those tests passing over a
     different game. */
  assert.deepEqual(
    {
      HISTORY_MAX: S.HISTORY_MAX,
      MAX_GRADE: S.MAX_GRADE,
      MAX_SECONDS: S.MAX_SECONDS,
      MIN_MEDIAN_N: S.MIN_MEDIAN_N,
      MIN_TREND_N: S.MIN_TREND_N,
      TREND_WINDOW: S.TREND_WINDOW,
      WINSOR_FACTOR: S.WINSOR_FACTOR,
      WILSON_Z: S.WILSON_Z,
      TREND_BAND: S.TREND_BAND,
      NOISE_K: S.NOISE_K,
      DECLINE_BAR: S.DECLINE_BAR,
      LAYOFF_MS: S.LAYOFF_MS,
      STALE_MIN_N: S.STALE_MIN_N,
      STALE_RUN: S.STALE_RUN,
      STALE_FLAWLESS_LOW: S.STALE_FLAWLESS_LOW,
    },
    {
      HISTORY_MAX: 120,
      MAX_GRADE: 4,
      MAX_SECONDS: 86400,
      MIN_MEDIAN_N: 5,
      MIN_TREND_N: 8,
      TREND_WINDOW: 20,
      WINSOR_FACTOR: 3,
      WILSON_Z: 1.96,
      TREND_BAND: 0.08,
      NOISE_K: 0.5,
      DECLINE_BAR: 1.5,
      LAYOFF_MS: 12096e5,
      STALE_MIN_N: 12,
      STALE_RUN: 10,
      STALE_FLAWLESS_LOW: 0.8,
    },
  );
  assert.equal(S.MAX_SECONDS, 24 * 60 * 60, 'a stored time past one day is no solve time');
  assert.equal(S.LAYOFF_MS, 14 * DAY);
});

test('quantile interpolates, clamps p, and answers null on an empty series', () => {
  assert.equal(S.quantile([], 0.5), null, 'an empty series has no median');
  assert.equal(S.quantile([7], 0.9), 7, 'one point is every quantile of itself');
  /* Type 7: p lands between two order statistics and the answer is read off the
     line between them, so two samples give a real midpoint and not one of them. */
  assert.equal(S.quantile([10, 20], 0.5), 15);
  assert.equal(S.quantile([10, 20], 0.25), 12.5);
  assert.equal(S.quantile([10, 20], 0.75), 17.5);
  assert.equal(S.quantile([10, 20], 0.9), 19);
  assert.equal(S.quantile([100, 200, 300], 0.5), 200, 'an odd count lands on the middle sample');
  assert.equal(S.quantile([100, 200, 300], 0.25), 150);
  assert.equal(S.quantile([1, 2, 3, 4], 0), 1, 'p at or under 0 is the minimum');
  assert.equal(S.quantile([1, 2, 3, 4], 1), 4, 'p at or over 1 is the maximum');
  assert.equal(S.quantile([1, 2, 3, 4], -5), 1);
  assert.equal(S.quantile([1, 2, 3, 4], 5), 4);
  assert.equal(S.quantile([5, 5, 5, 5], 0.75), 5, 'identical values divide nothing');
  assert.equal(S.quantile([0, 0, 0], 0.5), 0, 'and neither does a series of zeros');
});

test('summarize says nothing under five games and whole seconds over it', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const thin = S.summarize(series(n, (i) => 100 + i * 10));
    assert.equal(thin.n, n, 'the count is always a number, even where the quantiles are not');
    for (const p of ['median', 'p25', 'p75', 'p90']) {
      assert.equal(thin[p], null, `${p} at ${n} games moves with every game played`);
    }
  }
  assert.deepEqual(S.summarize([300, 320, 340, 360, 900]), {
    n: 5,
    median: 340,
    p25: 320,
    p75: 360,
    p90: 684,
  });
  assert.deepEqual(S.summarize([0, 0, 0, 0, 0]), { n: 5, median: 0, p25: 0, p75: 0, p90: 0 });
  /* Six games whose four quantiles all interpolate to a fraction: 127.5, 113.75,
     141.25 and 149.5. The caller formats mm:ss with a remainder, so a fraction
     surviving to the dialog renders as 2:07.5. */
  const fat = S.summarize([100, 111, 122, 133, 144, 155]);
  assert.deepEqual(fat, { n: 6, median: 128, p25: 114, p75: 141, p90: 150 });
  for (const p of ['median', 'p25', 'p75', 'p90']) {
    assert.ok(Number.isInteger(fat[p]), `${p} is a whole second, so fmt() never prints 5:23.5`);
  }
});

test('the median holds where a mean would run away', () => {
  /* Eleven games, then the same eleven with the slowest one replaced by a single
     hour long sitting. Solve times are right skewed by construction: a floor set
     by how fast a person can type, and a tail with no limit on it. */
  const tame = [180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380];
  const skewed = tame.slice(0, 10).concat([3600]);
  const band = { n: 11, median: 280, p25: 230, p75: 330, p90: 360 };
  assert.deepEqual(S.summarize(tame), band);
  assert.deepEqual(S.summarize(skewed), band, 'one interruption moves no quantile at all');

  assert.equal(mean(tame), 280);
  assert.ok(near(mean(skewed), 572.7272727272727), `the mean answered ${mean(skewed)}`);
  assert.equal(
    skewed.filter((v) => v < mean(skewed)).length,
    10,
    'the mean now sits above ten of the eleven games, which is why it is not the headline',
  );
});

test('wilson widens where the normal approximation claims certainty', () => {
  assert.deepEqual(S.wilson(0, 0), { n: 0, rate: null, low: null, high: null });
  assert.deepEqual(S.wilson(1, Number.NaN), { n: 0, rate: null, low: null, high: null });
  assert.deepEqual(S.wilson(1, -3), { n: 0, rate: null, low: null, high: null });
  assert.deepEqual(S.wilson(1, Number.POSITIVE_INFINITY), {
    n: 0,
    rate: null,
    low: null,
    high: null,
  });

  /* The whole reason this is not p plus or minus two standard deviations: at six
     of six that approximation gives a width of zero and claims certainty from six
     games. The lower bound below is what six games are actually worth. */
  const perfect = S.wilson(6, 6);
  assert.equal(perfect.rate, 1);
  assert.ok(near(perfect.low, 0.6097), `six of six answered ${perfect.low}`);
  assert.ok(perfect.low < 0.62, 'and it is nowhere near claiming the player never slips');
  assert.equal(perfect.high, 1);

  const none = S.wilson(0, 5);
  assert.equal(none.rate, 0);
  assert.equal(none.low, 0);
  assert.ok(near(none.high, 0.4345), `zero of five answered ${none.high}`);

  const lucky = S.wilson(3, 3);
  assert.ok(near(lucky.low, 0.4385), `three of three answered ${lucky.low}`);
  const half = S.wilson(2, 4);
  assert.equal(half.rate, 0.5);
  assert.ok(near(half.low, 0.15) && near(half.high, 0.85), `two of four answered ${half.low}`);

  /* A stored count above n is what a player editing localStorage produces. The
     clamp is what keeps p under 1, so p * (1 - p) never goes negative and the
     square root of it never answers NaN. */
  const hostile = S.wilson(9, 5);
  assert.equal(hostile.rate, 1);
  for (const k of ['low', 'high']) assert.ok(Number.isFinite(hostile[k]), `${k} is not a number`);
  const negative = S.wilson(-4, 5);
  assert.equal(negative.rate, 0);
  assert.equal(negative.low, 0);
});

test('winsorize caps at three medians, keeps order, and survives a series of zeros', () => {
  assert.deepEqual(S.winsorize([10, 10, 10, 10, 500]), [10, 10, 10, 10, 30]);
  assert.deepEqual(S.winsorize([10, 20, 30]), [10, 20, 30], 'nothing under the cap moves');
  assert.deepEqual(S.winsorize([], 3), []);
  /* Flooring the median at one second is what stops a series whose median is 0
     from collapsing every value onto 0. */
  assert.deepEqual(S.winsorize([0, 0, 0, 0]), [0, 0, 0, 0]);
  const long = series(9, (i) => 100 + i);
  assert.equal(S.winsorize(long).length, long.length);
  assert.equal(S.winsorize([500, 10, 10, 10, 10])[0], 30, 'the cap is applied in place');
  assert.deepEqual(
    S.winsorize([10, 10, 10, 10, 500], 2),
    [10, 10, 10, 10, 20],
    'the factor is read',
  );

  const source = [10, 10, 10, 10, 500];
  S.winsorize(source);
  assert.deepEqual(source, [10, 10, 10, 10, 500], 'the series handed in is left as it was');
});

test('the game the player walked away from feeds no trend and stays on the record', () => {
  /* Ten games at one grade, the last of them a tab left open over lunch. The cap
     is applied on the way into the trend and never on the way into the row: the
     row is the record of what happened and the trend is a model of it. */
  const rows = series(10, (i) => row(i, i === 9 ? 5000 : 400, 1));
  const here = S.gradeReport(rows);
  assert.equal(here.verdict, 'same', 'one interruption is not a decline');
  assert.equal(here.ratio, 1);
  assert.equal(here.pct, 0, 'so the copy has no percentage to print');
  assert.equal(here.median, 400);
  assert.equal(here.p90, 860, 'p90 is read off the stored seconds, interruption included');
  assert.equal(rows[9].s, 5000, 'and the row still says what the clock said');

  const capped = S.winsorize(secondsOf(rows));
  assert.equal(capped[9], 1200, 'the trend sees three medians and no more');
});

test('toLog floors at one second so log(0) never reaches a mean', () => {
  assert.deepEqual(S.toLog([0]), [0]);
  assert.deepEqual(S.toLog([1]), [0]);
  assert.deepEqual(S.toLog([Math.E]), [1]);
  assert.deepEqual(S.toLog([]), []);
  assert.deepEqual(S.toLog([0, 0.5, 1]), [0, 0, 0], 'anything under a second is one second');
});

test('logSlope is the median pairwise slope and one outlier does not move it', () => {
  assert.equal(S.logSlope([]), 0);
  assert.equal(S.logSlope([3]), 0, 'one point has no slope, and the caller multiplies by it');
  assert.equal(S.logSlope([0, 2, 4, 6, 8]), 2);
  assert.equal(S.logSlope([0, 2, 4, 6, 800]), 2, 'a least squares fit would follow the last point');
  assert.equal(S.logSlope([0, -2, -4, -6, -8]), -2);
  assert.equal(S.logSlope([5, 5, 5, 5]), 0, 'a flat series has no direction');
});

test('a verdict needs nine games, and eight can only ever answer the same', () => {
  const faster = (n) => series(n, (i) => 900 - 60 * i);
  for (let n = 0; n < S.MIN_TREND_N; n++) {
    const call = S.verdict(faster(n));
    assert.equal(call.verdict, 'few', `${n} games claimed a direction`);
    assert.equal(call.n, n);
    assert.equal(call.change, 0);
    assert.equal(call.ratio, 1, 'nothing under the threshold is allowed to print a percentage');
  }
  assert.deepEqual(S.trend([1, 2, 3, 4, 5, 6, 7]), { n: 7, verdict: 'few', change: 0, ratio: 1 });
  /* At eight the earlier window holds seven and answers "few", which agrees
     with nothing, so the hysteresis holds the sentence at "same". */
  assert.equal(S.verdict(faster(8)).verdict, 'same');
  assert.equal(S.trend(faster(8)).verdict, 'better', 'the single evaluation does see it');
  assert.equal(S.verdict(faster(9)).verdict, 'better');
  assert.equal(S.verdict(faster(10)).verdict, 'better');
});

test('the trend calls a real move and stays quiet through noise', () => {
  const better = S.verdict(secondsOf(ramp(12, 600, 310)));
  assert.equal(better.verdict, 'better');
  assert.ok(near(better.ratio, 0.5245), `ratio was ${better.ratio}`);

  const worse = S.verdict(secondsOf(ramp(12, 300, 613)));
  assert.equal(worse.verdict, 'worse');
  assert.ok(near(worse.ratio, 2.0089), `ratio was ${worse.ratio}`);

  const scatter = [400, 380, 420, 410, 390, 430, 405, 395, 415, 385, 425, 400];
  assert.equal(S.verdict(scatter).verdict, 'same', 'ordinary scatter is not a direction');
  /* Theil-Sen plus the winsor cap absorb the game the player walked away from. */
  assert.equal(S.verdict(scatter.slice(0, 11).concat([5000])).verdict, 'same');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 420))).verdict, 'same', 'five percent');

  for (const flat of [series(10, () => 400), series(10, () => 0)]) {
    const call = S.verdict(flat);
    assert.equal(call.verdict, 'same');
    assert.equal(call.change, 0);
    assert.equal(call.ratio, 1);
  }
});

test('the thresholds sit exactly where the constants put them', () => {
  /* Twelve game ramps from 400 seconds, one on each side of both edges, with the
     modelled change quoted beside each. TREND_BAND is 0.08 and DECLINE_BAR
     multiplies it by 1.5 for the slow direction, so the two edges sit four
     seconds of drift apart on one side and six on the other. */
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 370))).verdict, 'same', 'change is 0.0783');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 366))).verdict, 'better', 'change is 0.0891');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 450))).verdict, 'same', 'change is 0.1166');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 456))).verdict, 'worse', 'change is 0.1322');

  const over = S.trend(secondsOf(ramp(12, 400, 366)));
  assert.ok(near(over.change, -0.0891), `change was ${over.change}`);
  assert.ok(over.change < -S.TREND_BAND, 'the improvement clears the dead band');
  const under = S.trend(secondsOf(ramp(12, 400, 370)));
  assert.ok(Math.abs(under.change) < S.TREND_BAND, 'and the one below it does not');
});

test('slower has to clear a higher bar than faster', () => {
  /* The same size of drift, in the two directions. A move the fast side would
     have called an improvement is still "same" on the slow side, because on a
     leisure game a decline is spoken only when it is loud. */
  const slow = S.trend(secondsOf(ramp(12, 400, 436)));
  const fast = S.trend(secondsOf(ramp(12, 400, 368)));
  assert.ok(near(slow.change, 0.0858), `the slow drift was ${slow.change}`);
  assert.ok(near(fast.change, -0.0831), `the fast drift was ${fast.change}`);
  assert.equal(slow.verdict, 'same');
  assert.equal(fast.verdict, 'better');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 450))).verdict, 'same');
  assert.equal(S.verdict(secondsOf(ramp(12, 400, 460))).verdict, 'worse');
});

test('a player whose games scatter wide has to move further before it is said', () => {
  /* Three twelve game series, each alternating a quick board with a slow one and
     scaling the pair down by a constant factor every game, so the log spread
     holds still while the drift moves. All three clear TREND_BAND several times
     over, so the fixed band decides none of them. What decides them is the other
     term in Math.max(TREND_BAND, NOISE_K * spread): at a spread near 0.8 the
     noise floor lands near 0.4, and that is the number these have to beat.

     The first two sit on either side of it, which pins NOISE_K to between 0.41
     and 0.57. Half the spread is the claim that a change inside one game's
     ordinary scatter is a description of the scatter. */
  const noisy = [300, 698, 282, 657, 266, 618, 250, 582, 235, 547, 221, 515];
  const over = [300, 691, 276, 637, 255, 587, 235, 541, 216, 499, 199, 460];
  const clear = [300, 684, 271, 617, 244, 557, 221, 503, 199, 454, 180, 410];

  const held = S.trend(noisy);
  assert.equal(held.verdict, 'same', 'a 28 percent move, and still inside the ordinary scatter');
  assert.ok(near(held.change, -0.3346), `change was ${held.change}`);
  assert.ok(Math.abs(held.change) > 4 * S.TREND_BAND, 'four dead bands, so the band held nothing');

  const stepped = S.trend(over);
  assert.equal(stepped.verdict, 'better', 'one notch further and the floor is cleared');
  assert.ok(near(stepped.change, -0.4476), `change was ${stepped.change}`);

  /* A quarter of that move is called on a player whose games sit close together,
     because the bar is set by their own spread and not by the size of the move. */
  assert.equal(S.trend(secondsOf(ramp(12, 400, 366))).verdict, 'better', 'change is 0.0891');

  const spoken = S.verdict(clear);
  assert.equal(spoken.verdict, 'better', 'the last two evaluations both clear the floor');
  assert.ok(near(spoken.ratio, 0.5701), `ratio was ${spoken.ratio}`);
  assert.equal(S.verdict(over).verdict, 'same', 'while the middle one is agreed on once');

  /* pct is read off the ratio and from nothing else, so a move this size rides on
     a "same" verdict. The copy prints pct under "better" and "worse" only, and a
     third caller would print "el ritmo se mantiene" beside 28 percent. */
  const rows = noisy.map((s, i) => row(i, s, 2));
  assert.equal(S.gradeReport(rows).verdict, 'same');
  assert.equal(S.gradeReport(rows).pct, 28, 'a percentage the dialog is not allowed to reach for');
});

test('one game cannot flip the sentence on its own', () => {
  /* Both series are read twice: once as they stand, and once with the last game
     held back. A single evaluation over everything calls a direction, the
     evaluation one game earlier does not, and the two have to agree before the
     dialog says anything, so the spoken verdict is "same" either way. */
  for (const [to, called] of [
    [368, 'better'],
    [452, 'worse'],
  ]) {
    const all = secondsOf(ramp(12, 400, to));
    assert.equal(S.trend(all).verdict, called, `the newest game alone reads as ${called}`);
    assert.equal(S.trend(all.slice(0, -1)).verdict, 'same', 'the game before it does not agree');
    assert.equal(S.verdict(all).verdict, 'same', `${called} was spoken on one game`);
  }
  /* Two games further along the same ramp both agree, and only then is it said. */
  const agreed = secondsOf(ramp(12, 400, 366));
  assert.equal(S.trend(agreed).verdict, 'better');
  assert.equal(S.trend(agreed.slice(0, -1)).verdict, 'better');
  assert.equal(S.verdict(agreed).verdict, 'better');
});

test('the window forgets an improvement that finished months ago', () => {
  /* Forty games: the first twenty go from 900 seconds to 330, and the twenty
     since have sat flat around 300. The player stopped improving twenty games
     ago and the sentence has to stop saying they are. */
  const times = series(40, (i) => (i < S.TREND_WINDOW ? 900 - 30 * i : 300 + (i % 3)));
  assert.equal(S.trend(times).verdict, 'better', 'the whole history still holds the improvement');
  const call = S.verdict(times);
  assert.equal(call.verdict, 'same');
  assert.equal(call.n, S.TREND_WINDOW, 'n is the window, not the games played at the grade');

  const rows = times.map((s, i) => row(i, s, 1));
  const here = S.gradeReport(rows);
  assert.equal(here.n, 40, 'while the count is every game at the grade');
  assert.equal(here.verdict, 'same');
});

test('readRow validates every field, because a player can type into storage', () => {
  const good = { t: 1754380800000, s: 423, m: 2, h: 1, g: 2, d: 'medium' };
  assert.deepEqual(S.readRow(good, KEYS), good);
  assert.deepEqual(S.readRow({ t: '1', s: '2', m: '3', h: '4', g: '2', d: 'medium' }, KEYS), {
    t: 1,
    s: 2,
    m: 3,
    h: 4,
    g: 2,
    d: 'medium',
  });
  assert.deepEqual(S.readRow({ t: 1.9, s: 2.9, m: 3.9, h: 4.9, g: 2.9, d: 'medium' }, KEYS), {
    t: 1,
    s: 2,
    m: 3,
    h: 4,
    g: 2,
    d: 'medium',
  });
  assert.equal(S.readRow(null), null);
  assert.equal(S.readRow(undefined), null);
  assert.equal(S.readRow(5), null);
  assert.equal(S.readRow('x'), null);
  assert.equal(S.readRow([]), null, 'an array carries none of the fields');
  assert.equal(S.readRow({ ...good, t: 'x' }, KEYS), null);
  assert.equal(S.readRow({ ...good, t: Number.POSITIVE_INFINITY }, KEYS), null);
  assert.equal(S.readRow({ ...good, s: -1 }, KEYS), null, 'a negative time is not a time');
  assert.equal(S.readRow({ ...good, s: S.MAX_SECONDS + 1 }, KEYS), null);
  assert.equal(S.readRow({ ...good, s: S.MAX_SECONDS }, KEYS).s, S.MAX_SECONDS, 'a day is legal');
  assert.equal(S.readRow({ ...good, s: 'x' }, KEYS), null);
  assert.equal(S.readRow({ ...good, s: Number.NaN }, KEYS), null);
  assert.equal(S.readRow({ ...good, m: -1 }, KEYS), null);
  assert.equal(S.readRow({ ...good, m: 'x' }, KEYS), null);
  assert.equal(S.readRow({ ...good, h: -1 }, KEYS), null);
  assert.equal(S.readRow({ ...good, h: 'x' }, KEYS), null);
  assert.equal(S.readRow({ ...good, s: 0, m: 0, h: 0 }, KEYS).s, 0, 'zero is a legal time');
  /* A clock set to last century is still a game somebody played. */
  assert.equal(S.readRow({ ...good, t: -5 }, KEYS).t, -5);

  /* An unplaceable grade is held out of the grade stratified statistics without
     costing the row, which still counts as a game. */
  assert.equal(S.readRow({ ...good, g: 9 }, KEYS).g, 0);
  assert.equal(S.readRow({ ...good, g: 0 }, KEYS).g, 0);
  assert.equal(S.readRow({ ...good, g: -1 }, KEYS).g, 0);
  assert.equal(S.readRow({ ...good, g: 'x' }, KEYS).g, 0);
  assert.equal(S.readRow({ ...good, g: 'constructor' }, KEYS).g, 0);
  assert.equal(S.readRow({ ...good, g: S.MAX_GRADE }, KEYS).g, S.MAX_GRADE);
  assert.equal(S.readRow({ ...good, g: S.MAX_GRADE + 1 }, KEYS).g, 0);

  assert.equal(S.readRow({ ...good, d: 'nope' }, KEYS).d, '');
  assert.equal(S.readRow({ ...good, d: '__proto__' }, KEYS).d, '');
  assert.equal(S.readRow({ ...good, d: 7 }, KEYS).d, '');
  assert.equal(S.readRow(good).d, '', 'with no keys handed in, no difficulty is known');
  assert.equal(S.readRow(good, ['medium']).d, 'medium');
});

test('readRows drops what it cannot read, keeps order, and trims to the ring', () => {
  assert.deepEqual(S.readRows('nope'), []);
  assert.deepEqual(S.readRows(null), []);
  assert.deepEqual(S.readRows(undefined), []);
  assert.deepEqual(S.readRows({ 0: row(0, 10, 1), length: 1 }), [], 'and it is not array like');
  const mixed = [row(0, 10, 1), null, 'x', { t: 1, s: -1, m: 0, h: 0 }, row(1, 20, 1)];
  const kept = S.readRows(mixed, KEYS);
  assert.equal(kept.length, 2);
  assert.deepEqual(secondsOf(kept), [10, 20], 'order is chronological and nothing sorts it');

  const over = series(S.HISTORY_MAX + 10, (i) => row(i, i, 1));
  const trimmed = S.readRows(over, KEYS);
  assert.equal(trimmed.length, S.HISTORY_MAX);
  assert.equal(trimmed[0].s, 10, 'the oldest rows fall off the front');
  assert.equal(trimmed[trimmed.length - 1].s, S.HISTORY_MAX + 9);
});

test('flawless is the same test that pays the bonus', () => {
  assert.equal(S.isFlawless({ m: 0, h: 0 }), true);
  assert.equal(S.isFlawless({ m: 1, h: 0 }), false);
  assert.equal(S.isFlawless({ m: 0, h: 1 }), false);
  assert.equal(S.isFlawless({ m: 3, h: 2 }), false);
});

test('the empty report throws nothing, because it paints before the save loads', () => {
  const empty = S.gradeReport([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.median, null);
  assert.equal(empty.flawless.rate, null);
  assert.equal(empty.flawless.low, null);
  assert.equal(empty.verdict, 'few');
  assert.equal(empty.pct, 0);
  assert.equal(empty.layoffDays, 0);

  /* One game is enough to have a flawless rate and nowhere near enough to have a
     median, and the gap that decides a layoff needs two rows to exist at all. */
  const one = S.gradeReport([row(0, 300, 1)]);
  assert.equal(one.n, 1);
  assert.equal(one.median, null);
  assert.equal(one.flawless.rate, 1);
  assert.equal(one.verdict, 'few');
  assert.equal(one.layoffDays, 0);

  const view = S.report([]);
  assert.equal(view.n, 0);
  assert.equal(view.measured, 0);
  assert.equal(view.top, 0);
  assert.equal(view.offer, null);
  for (let g = 1; g <= S.MAX_GRADE; g++) {
    assert.equal(view.grades[g].n, 0, `grade ${g} is missing from the report`);
  }
});

test('the median gate opens on the fifth game and the clean rate does not wait for it', () => {
  /* A null median is what the dialog hides the band behind, so the gate is read
     one game either side of it. Four games put p25 and p75 on the two middle
     observations, where the fifth game moves both.

     The flawless rate is on the open side of that gate. It is a proportion, and
     its Wilson interval widens on its own to say what four games are worth, so
     it carries its own uncertainty and needs no floor under it. */
  const upto = (n) =>
    S.gradeReport(series(n, (i) => row(i, 300 + i * 10, 2, { m: i === 0 ? 1 : 0 })));

  const four = upto(S.MIN_MEDIAN_N - 1);
  assert.equal(four.n, 4);
  for (const p of ['median', 'p25', 'p75', 'p90']) {
    assert.equal(four[p], null, `${p} at four games is not worth printing`);
  }
  assert.equal(four.flawless.rate, 0.75, 'three clean out of four is still a rate');
  assert.ok(near(four.flawless.low, 0.3006), `four games answered ${four.flawless.low}`);

  const five = upto(S.MIN_MEDIAN_N);
  assert.equal(five.median, 320);
  assert.equal(five.p25, 310);
  assert.equal(five.p75, 330);
  assert.equal(five.p90, 336, 'p90 runs six tenths of the way from the fourth game to the fifth');
  assert.equal(five.flawless.rate, 0.8);
  assert.equal(five.verdict, 'few', 'a median is not yet a direction');
});

test('a slower run after two weeks away is a layoff and not a regression', () => {
  const dec = ramp(12, 300, 613, 2);
  assert.equal(S.gradeReport(dec).verdict, 'worse', 'one day apart it is what it looks like');
  assert.equal(S.gradeReport(dec).layoffDays, 0);
  assert.equal(S.gradeReport(dec).pct, 101, 'the copy prints a whole percent');

  const away = dec.slice();
  away[11] = { ...away[11], t: away[10].t + 15 * DAY };
  const call = S.gradeReport(away);
  assert.equal(call.verdict, 'layoff');
  assert.equal(call.layoffDays, 15);

  /* Fourteen days to the millisecond is a layoff and one millisecond under it is
     not, which is the whole of the rule. */
  const exact = dec.slice();
  exact[11] = { ...exact[11], t: exact[10].t + S.LAYOFF_MS };
  assert.equal(S.gradeReport(exact).verdict, 'layoff');
  assert.equal(S.gradeReport(exact).layoffDays, 14);
  const short = dec.slice();
  short[11] = { ...short[11], t: short[10].t + S.LAYOFF_MS - 1 };
  assert.equal(S.gradeReport(short).verdict, 'worse');
  assert.equal(S.gradeReport(short).layoffDays, 0);

  /* Good news is never overridden by an excuse. */
  const better = ramp(12, 600, 310, 2);
  better[11] = { ...better[11], t: better[10].t + 15 * DAY };
  assert.equal(S.gradeReport(better).verdict, 'better');
  assert.equal(S.gradeReport(better).pct, 48);

  /* A clock moved backwards produces a negative gap, which is never a layoff. */
  const backwards = dec.slice();
  backwards[11] = { ...backwards[11], t: backwards[10].t - 20 * DAY };
  assert.equal(S.gradeReport(backwards).verdict, 'worse');
  assert.equal(S.gradeReport(backwards).layoffDays, 0);
});

test('the report stratifies on the measured grade and names the last one played', () => {
  const rows = [row(0, 300, 1), row(1, 400, 2), row(2, 500, 0), row(3, 350, 1)];
  const view = S.report(rows);
  assert.equal(view.n, 4, 'an ungraded row is still a game');
  assert.equal(view.measured, 3);
  assert.equal(view.grades[1].n, 2);
  assert.equal(view.grades[2].n, 1);
  assert.equal(view.grades[3].n, 0);
  assert.equal(view.grades[4].n, 0);
  /* Nothing here has the five games a median needs, so the answer falls back to
     the level the player just finished. */
  assert.equal(view.top, 1, 'the level the player just finished');
  assert.equal(S.report([row(0, 300, 0)]).top, 0, 'nothing measured names no level');
  assert.equal(S.report([row(0, 300, 4)]).top, 4);
});

test('one board that missed its tier does not carry the block onto that tier', () => {
  /* The generator lands off target on about one Peludo board in seven, and the
     report is stratified on the grade a board was measured at. Naming the last
     row's grade straight meant twenty games of evidence were replaced by one
     game at a level the player never chose, with every number under it null. */
  const peludo = series(20, (i) => row(i, 400, 3));
  const missed = peludo.concat([row(20, 380, 2)]);
  assert.equal(S.report(missed).top, 3, 'one off target board emptied the block');
  assert.equal(S.report(missed).grades[3].n, 20);
  assert.equal(S.report(missed).grades[2].n, 1, 'the stray board still counts where it landed');
  assert.ok(S.report(missed).grades[3].median !== null, 'the level named has numbers under it');

  /* And the moment that level has games of its own it is named again, because by
     then it is where the player has been playing. */
  const moved = missed.concat(series(4, (i) => row(21 + i, 380, 2)));
  assert.equal(S.report(moved).grades[2].n, S.MIN_MEDIAN_N);
  assert.equal(S.report(moved).top, 2);
});

test('the offer fires only when flat, unmoving and saturated', () => {
  const flat = (g, n = 16, extra = {}) => series(n, (i) => row(i, 400 + (i % 3), g, extra));

  assert.deepEqual(S.report(flat(1)).offer, { from: 1, to: 2 });
  assert.deepEqual(S.report(flat(2)).offer, { from: 2, to: 3 });
  assert.deepEqual(S.report(flat(3)).offer, { from: 3, to: 4 });
  assert.equal(S.report(flat(S.MAX_GRADE)).offer, null, 'there is no tier above the last one');

  /* Saturation is read off the Wilson lower bound, so it takes sixteen flawless
     games in a row. Fifteen answer 0.7961 and the sixteenth answers 0.8064,
     which is the bar. A rate of 1.0 on its own would fire this on a lucky three. */
  assert.equal(S.report(flat(1, 15)).offer, null);
  assert.ok(S.report(flat(1, 15)).grades[1].flawless.low < S.STALE_FLAWLESS_LOW);
  assert.ok(S.report(flat(1, 16)).grades[1].flawless.low >= S.STALE_FLAWLESS_LOW);
  /* At eleven games both gates are shut: the count is under STALE_MIN_N and the
     lower bound is under the bar. Nothing is stale that recently. */
  assert.equal(S.report(flat(1, S.STALE_MIN_N - 1)).offer, null);

  /* Three hinted games drop the lower bound under the bar. */
  const hinted = flat(1);
  for (let i = 0; i < 3; i++) hinted[i] = { ...hinted[i], h: 1 };
  assert.equal(S.report(hinted).offer, null);

  /* The mix has moved, so the ladder is already being climbed. Both rings below
     hold sixteen flawless games at grade 1 and answer differently, because the
     one that counts is whether the last ten measured games are all one grade. */
  const seventeen = series(17, (i) => row(i, 400 + (i % 3), 1));
  const behind = seventeen.slice();
  behind[6] = row(6, 401, 2);
  assert.equal(S.report(behind).grades[1].n, 16);
  assert.deepEqual(S.report(behind).offer, { from: 1, to: 2 }, 'eleven games back is out of view');
  const inside = seventeen.slice();
  inside[10] = row(10, 401, 2);
  assert.equal(S.report(inside).grades[1].n, 16);
  assert.equal(S.report(inside).top, 1);
  assert.equal(S.report(inside).offer, null, 'one game at another grade is a mix that moved');

  /* A player who is still getting faster is not stale. */
  assert.equal(S.report(ramp(16, 600, 310, 1)).offer, null);
  assert.equal(S.report(ramp(16, 600, 310, 1)).grades[1].verdict, 'better');
});

test('nothing in the report is NaN or Infinity, whatever the rows say', () => {
  /* The hostile ring is read the way the game reads it, through readRows, which
     is the only door rows come through. What survives that is what the report
     has to survive, and a NaN reaching the dialog renders as the string "NaN"
     and is then written back to storage. */
  const hostile = [
    null,
    undefined,
    0,
    'x',
    [],
    { t: 1, s: -5, m: 0, h: 0 },
    { t: 1, s: 1e9, m: 0, h: 0 },
    { t: 1, s: 10, m: -1, h: 0 },
    { t: Number.NaN, s: 10, m: 0, h: 0 },
    { t: 1, s: 10, m: 0, h: 0, g: 'constructor' },
    { t: 1, s: 10, m: 0, h: 0, g: 99, d: '__proto__' },
    { t: 1.9, s: 10.9, m: 0.9, h: 0.9, g: 2.9, d: 'easy' },
  ];
  const kept = S.readRows(hostile, ['easy']);
  assert.equal(kept.length, 3, 'nine of the twelve rows are not games');
  assert.deepEqual(kept[2], { t: 1, s: 10, m: 0, h: 0, g: 2, d: 'easy' });

  const rings = [
    [],
    kept,
    [row(0, 0, 1)],
    series(40, (i) => row(i, 0, 1)),
    series(40, (i) => row(i, i % 2 ? 1 : S.MAX_SECONDS, 4)),
    series(40, (i) => row(i, 400, (i % 5) + 0, { m: i % 3, h: i % 2 })),
    series(40, (i) => row(i, 400, 1, { t: -i * DAY })),
    ramp(40, 900, 60, 3),
  ];
  for (const rows of rings) {
    const view = S.report(rows);
    const seen = JSON.stringify(view, (_k, v) =>
      typeof v === 'number' && !Number.isFinite(v) ? 'BAD' : v,
    );
    assert.ok(!seen.includes('BAD'), `a report went non finite: ${seen}`);
  }
});
