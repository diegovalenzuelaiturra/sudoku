# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/diegovalenzuelaiturra/sudoku/security/advisories/new)
rather than opening a public issue.

You should get an acknowledgement within a few days. This is a personal
project, so please treat that as best effort rather than a guarantee.

## Scope

The published site is a handful of static files served by GitHub Pages: the
whole app inline in `index.html`, the puzzle generator in `generator.js`,
which the page loads as a worker or a plain script, plus a web app manifest, a
service worker that precaches that shell, an icon and an error page. It has no
backend, no accounts and no personal data, and it talks to no third party:
every request it makes is for its own same-origin files. The game in progress
(board, notes, timer, mistakes, hints) is saved to `localStorage` on the
device and never leaves it.

That narrows what a vulnerability here can realistically be. Things worth
reporting:

- anything that causes the page to execute content it should not
- anything that lets the service worker cache or serve content it should not,
  or that leaves a stale shell pinned after a deploy
- a flaw in the build or deployment workflows that could let unreviewed code
  reach the published site
- a dependency issue affecting the test tooling in `package.json`

Out of scope: puzzle difficulty, generator behaviour, and gameplay bugs. Those
are ordinary issues, not security reports; please open a regular issue.

## Supported versions

Only the currently deployed site is supported. There are no releases or
maintained branches; `main` is what is live.
