# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/diegovalenzuelaiturra/sudoku/security/advisories/new)
rather than opening a public issue.

You should get an acknowledgement within a few days. This is a personal
project, so please treat that as best effort rather than a guarantee.

## Scope

The published site is a single self-contained `index.html`, served as a static
file by GitHub Pages. It makes no network requests, stores nothing off-device,
handles no accounts or personal data, and has no backend.

That narrows what a vulnerability here can realistically be. Things worth
reporting:

- anything that causes the page to execute content it should not
- a flaw in the build or deployment workflows that could let unreviewed code
  reach the published site
- a dependency issue affecting the test tooling in `package.json`

Out of scope: puzzle difficulty, generator behaviour, and gameplay bugs. Those
are ordinary issues, not security reports — please open a regular issue.

## Supported versions

Only the currently deployed site is supported. There are no releases or
maintained branches; `main` is what is live.
