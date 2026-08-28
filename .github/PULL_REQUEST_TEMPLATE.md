<!--
Title: an imperative summary, for example "Pin the deploy workflow's actions to
commit SHAs". There is no issue tracker here, so the title and the section below
are the whole record of why this change exists.

Delete any section that does not apply. Delete these comments.
-->

## What and why

<!-- Two to four sentences. What changed, and what problem it solves. -->

## How verified

<!--
Commands run and their output, screenshots for anything visual. "CI is green" on
its own is not evidence of the behaviour you changed: it says the suite still
passes, which it also did before the change. Say what you ran that would have
failed without this diff.

The local gate, which is what CI runs:
  npm run lint            the git hooks from .pre-commit-config.yaml, every file
  npm run test:coverage   the unit suite, with the coverage floor CI enforces
  npm run test:e2e        Playwright against a real Chromium and a real WebKit
  npm run build           worth running alone only if you touched the build
-->

## After the merge

<!--
This repository publishes a live site, and the checks that look at the published
result only run once the change lands on main, so they are not visible on this
pull request. Say here what you expect them to report, so a reviewer knows what
to watch afterwards and what would count as wrong.

The deploy workflow probes the live address for the root page and for every file
the build published, so a renamed, dropped or newly added asset shows up there
first. It then runs Lighthouse against that address and holds it to
scripts/check-budget.mjs: accessibility exactly 100, LCP, CLS and TBT under
their ceilings. Both run after the deployment is already live, so neither can
hold a bad deploy back, and a breach is a follow up rather than a block.
-->

## Notes for the reviewer

<!--
Optional. Decisions worth arguing with, alternatives rejected and why, anything
deliberately left out. If the diff contains a change the title does not imply,
say so here.
-->
