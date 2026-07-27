# Working in this repository

A Sudoku game in Spanish. Static, no runtime dependencies, published to GitHub
Pages. The conventions below are not style preferences: each one is either
enforced by a test or exists because breaking it shipped a bug.

## What ships

Four things reach the browser: `index.html`, `generator.js`, `sw.js` and
`icons/`. `index.html` is the whole interface, styles and script inline.
`generator.js` is the only other script.

Adding a published file means adding it in three places, and a test fails if you
miss one:

- `ALLOWLIST` in `scripts/build.mjs`, which is fail closed: anything not named
  there is never read, so a forgotten entry is a silent 404 in production.
- `APP_SHELL` in `sw.js`, or the installed app breaks offline.
- `PUBLISHED` in `tests/assets.test.mjs`.

## Rules that have teeth

**No em dashes, en dashes or middle dots.** Anywhere: code, comments, copy,
commit messages, pull request bodies. `tests/typography.test.mjs` scans the tree
and fails on them. Use commas, colons, or rewrite the sentence.

**Every path is relative.** This is a project site served under `/sudoku/` on an
account domain shared with other repositories, so a path starting with `/`
resolves against a different site, loads nothing and logs nothing. The only
absolute URLs are the social metadata, which scrapers fetch out of context.

**Preview with `npm run preview`, never `python3 -m http.server`.** Serving the
repository root at `/` hides the whole class of bug above, serves source rather
than built output, and puts `.git` and `node_modules` on the wire.

**`generator.js` exports exactly one global, `SudokuGenerator`.** It runs as a
worker normally, but `index.html` injects it as a plain `<script>` when
constructing a worker throws. Two classic scripts declaring the same top level
`const` is a SyntaxError, and `index.html` has its own `boxOf` and `PEERS`, so
anything else leaking out of that file breaks the fallback silently.

**Comments are load bearing.** Several exist specifically to stop a fixed bug
being reintroduced, and they record measurements that were expensive to take.
The published copy is stripped by the minifier, so keeping them costs nothing.
Explain why, not what.

## How the game is put together

Difficulty is the hardest technique a board needs, not its clue count. The
ladder is in `generator.js`: directas, bloques, pares, avanzado. The clue counts
in `DIFF` are only where the search starts, and the generator moves them to
reach a grade, so nothing may advertise a fixed number of clues. The grade a
board is reported at is always the grade it was measured at, never the one that
was requested: the search is allowed to miss, and the player is told the truth.

Every board is a pure function of a 32 bit seed, so a puzzle can be rebuilt from
the code shown at the end of a game, and the tests assert over fixed seeds
rather than over whatever the last run produced.

Three localStorage keys, each versioned: `sudoku:save`, `sudoku:wallet`,
`sudoku:stats`. One rule holds across all of them. A reader that cannot make
sense of what is stored leaves it alone rather than overwriting it, because the
bytes probably belong to a newer build the player still has cached. The wallet
is the strictest, since what is in it was earned: it reads its own version and
the one before, refuses anything newer, and never writes over what it refused.

## Tests

```sh
npm test                # unit, a few seconds
npm run test:coverage   # the same, with the floor CI enforces
npm run test:e2e        # Playwright, real Chromium and real WebKit
npm run lint            # the git hooks, over every file
npm run lint:fix        # oxlint and ESLint, applying what they can fix
```

Two linters, configured not to overlap: oxlint runs its `correctness` rules, and
`eslint.config.mjs` reads `.oxlintrc.json` to switch off the ESLint rules oxlint
already covers. Both share the ignore list in `.oxlintrc.json`.

ESLint owns the HTML, through html-eslint, and reformats `index.html` and
`404.html` to a two space indent. It does not touch what is inside `<style>` or
`<script>`: the body of those elements is opaque text to it, so the game's own
JavaScript and CSS are linted by nothing and carried entirely by the suites
above. Editing the markup means running `npm run lint:fix` or watching CI fail
on indentation.

Unit tests read the shipped files and evaluate them, rather than importing a
copy, so they exercise what players actually run. The coverage floor only sees
files a test imports, so it will not notice a new script that nothing loads.

Two worktrees can run at once by setting `PLAYWRIGHT_PORT`.
