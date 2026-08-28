#!/usr/bin/env node

/* Judges a Lighthouse JSON report against the gates this page already meets.

     node scripts/check-budget.mjs .lighthouse/report.json

   Exit 0 when every gate holds, 1 when one is breached, 2 when the report
   cannot be read or the Lighthouse run itself failed. Plain Node, no
   dependencies, so it runs on the runner's Node with nothing installed. */

import { readFileSync, writeSync } from 'node:fs';

/* Accessibility takes no environment override: it was measured at 100 and is
   not allowed to regress. Every audit in the category scores 0 or 1, so the
   category score is a weighted mean of binary results and a single failing
   audit drops it below 1.0. There is no rounding band for a regression to hide
   in, which is why this compares exactly. */
const REQUIRED_ACCESSIBILITY = 1;

/* The timing ceilings sit well above what this page measures, deliberately.
   Runners are shared, 2 vCPU and noisy, and a budget that flakes gets disabled
   within a week, which protects less than a loose budget that never lies. Each
   number below is a published threshold, so it does not need renegotiating
   after every commit. */
const CHECKS = [
  {
    key: 'LCP',
    audit: 'largest-contentful-paint',
    env: 'LH_BUDGET_LCP_MS',
    /* 2500 ms, the Core Web Vitals "good" boundary. Measured 127 ms locally
       unthrottled, and about 250 ms under the desktop preset's simulated
       throttling that CI uses, so this leaves a factor of ten. A tighter
       ceiling, say 500 ms, sits inside the spread that a cold Chrome start on
       a contended runner produces by itself. 2500 ms still catches anything
       worth catching: the page is one self contained 56 KB document, so a web
       font, a blocking script or a hero image overshoots it easily. */
    budget: 2500,
    format: (value) => `${Math.round(value)} ms`,
  },
  {
    key: 'CLS',
    audit: 'cumulative-layout-shift',
    env: 'LH_BUDGET_CLS',
    /* 0.10, the Core Web Vitals "good" boundary. CLS measures layout
       stability, so it barely moves with hardware speed: measured 0.00, and
       the page loads no late arriving image or font that could reflow it. The
       margin covers sub pixel differences between Chrome builds; a real
       unreserved space regression clears 0.10 in one shift. */
    budget: 0.1,
    format: (value) => value.toFixed(3),
  },
  {
    key: 'TBT',
    audit: 'total-blocking-time',
    env: 'LH_BUDGET_TBT_MS',
    /* 300 ms. Lighthouse itself treats 200 ms as good on mobile and 150 ms on
       desktop. TBT is the metric most exposed to CPU contention: on a shared
       runner one long task during Chrome startup, or a single GC pause, can
       book 100 ms of blocking that has nothing to do with the page. 300 ms
       absorbs that. Measured 0 ms, so a breach means the page genuinely
       started doing work at boot, which is the thing worth failing a build
       over; jitter around zero is not. */
    budget: 300,
    format: (value) => `${Math.round(value)} ms`,
  },
];

/* writeSync puts the message on stderr synchronously. console.error's writes
   are asynchronous when stderr is a pipe, which is what CI hands us, and
   process.exit() can drop one in flight. Losing the exit code would be worse,
   but losing the reason for the failure is how a gate ends up being deleted
   instead of fixed. */
function abort(message) {
  writeSync(2, `check-budget: ${message}\n`);
  process.exit(2);
}

const reportPath = process.argv[2];
if (!reportPath) abort('usage: node scripts/check-budget.mjs <lighthouse-report.json>');

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  abort(`cannot read ${reportPath}: ${error.message}`);
}

if (report === null || typeof report !== 'object') {
  abort(`${reportPath} does not hold a lighthouse json report`);
}

/* A run that never loaded the page still writes a report, with the reason in
   runtimeError and the audits absent. Reporting three "not reported" metrics
   for that would read like a bug in this script instead of a broken run. */
if (report.runtimeError?.code && report.runtimeError.code !== 'NO_ERROR') {
  abort(
    `lighthouse run failed: ${report.runtimeError.code} ${report.runtimeError.message ?? ''}`.trim(),
  );
}

/* Overrides are parsed strictly. NaN loses every comparison it takes part in,
   so a typo such as "2,500" would silently switch off the gate it was meant to
   relax, and the build would go green on a page that got slower. */
function ceilingFor({ env, budget }) {
  const raw = process.env[env];
  if (raw === undefined || raw.trim() === '') return budget;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) abort(`${env}="${raw}" is not a non-negative number`);
  return parsed;
}

const rows = [];
const breaches = [];

const score = report.categories?.accessibility?.score;
if (typeof score !== 'number' || !Number.isFinite(score)) {
  breaches.push(
    'accessibility: the report carries no accessibility category, so the gate could not be checked',
  );
  rows.push(['A11Y', 'not reported', '100', 'FAIL']);
} else {
  /* Shown at the precision Lighthouse produced, not rounded to a flat 100,
     so a 99.96 never prints as a passing looking number next to FAIL. */
  const measured = String(Number((score * 100).toFixed(2)));
  const ok = score >= REQUIRED_ACCESSIBILITY;
  if (!ok) breaches.push(`accessibility scored ${measured}, and 100 is required`);
  rows.push(['A11Y', measured, '100', ok ? 'ok' : 'FAIL']);
}

for (const check of CHECKS) {
  const budget = ceilingFor(check);
  const measured = report.audits?.[check.audit]?.numericValue;

  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    breaches.push(`${check.key}: lighthouse reported no value for audit "${check.audit}"`);
    rows.push([check.key, 'not reported', check.format(budget), 'FAIL']);
    continue;
  }

  const ok = measured <= budget;
  if (!ok) {
    breaches.push(
      `${check.key} was ${check.format(measured)}, over its ${check.format(budget)} budget`,
    );
  }
  rows.push([check.key, check.format(measured), check.format(budget), ok ? 'ok' : 'FAIL']);
}

const header = ['metric', 'measured', 'budget', 'status'];
const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
const pad = (cell, i) => (i === 0 || i === 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]));
const render = (row) => row.map(pad).join('  ').trimEnd();

console.log(`report: ${reportPath}`);
console.log(`url:    ${report.finalDisplayedUrl ?? report.requestedUrl ?? 'unknown'}`);
console.log('');
console.log(render(header));
console.log(widths.map((width) => '-'.repeat(width)).join('  '));
for (const row of rows) console.log(render(row));
console.log('');

if (breaches.length === 0) {
  console.log('check-budget: pass, every gate holds');
} else {
  for (const breach of breaches) console.log(`breach: ${breach}`);
  console.log(`check-budget: fail, ${breaches.length} of ${rows.length} gates breached`);
  process.exitCode = 1;
}
