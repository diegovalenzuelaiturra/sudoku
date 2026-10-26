#!/usr/bin/env node

/* Judges a Lighthouse JSON report against the gates this page already meets.

     node scripts/check-budget.mjs .lighthouse/report.json

   Exit 0 when every gate holds, 1 when one is breached, 2 when the report
   cannot be read or the Lighthouse run itself failed. Plain Node, no
   dependencies, so it runs on the runner's Node with nothing installed. */

import { readFileSync, writeSync } from 'node:fs';

const REQUIRED_ACCESSIBILITY = 1;

const CHECKS = [
  {
    key: 'LCP',
    audit: 'largest-contentful-paint',
    env: 'LH_BUDGET_LCP_MS',
    budget: 2500,
    format: (value) => `${Math.round(value)} ms`,
  },
  {
    key: 'CLS',
    audit: 'cumulative-layout-shift',
    env: 'LH_BUDGET_CLS',
    budget: 0.1,
    format: (value) => value.toFixed(3),
  },
  {
    key: 'TBT',
    audit: 'total-blocking-time',
    env: 'LH_BUDGET_TBT_MS',
    budget: 300,
    format: (value) => `${Math.round(value)} ms`,
  },
];

// MUST KILL: abort exits with process.exit, which can truncate async stderr writes; a top level catch that sets exitCode removes the need for writeSync
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

if (report.runtimeError?.code && report.runtimeError.code !== 'NO_ERROR') {
  abort(
    `lighthouse run failed: ${report.runtimeError.code} ${report.runtimeError.message ?? ''}`.trim(),
  );
}

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
