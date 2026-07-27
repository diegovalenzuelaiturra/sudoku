# Working in this repository

A Sudoku game in Spanish. Static, no runtime dependencies, published to GitHub
Pages. The conventions below are not style preferences: each one is either
enforced by a test or exists because breaking it shipped a bug.

## What ships

Four things reach the browser: `index.html`, `generator.js`, `sw.js` and
`icons/`. `index.html` is the whole interface, with its styles inline.

The game itself is `app.js`, which is not published. `index.html` loads it with
`<script src="app.js">` and `scripts/build.mjs` folds it back into the page, so
what ships is still one file. It lives apart so the linters read it as
JavaScript rather than as text inside markup, which is where it used to be and
where nothing checked it. Add another such file to `INLINED_SCRIPTS` in
`scripts/build.mjs`, not to the allowlist: inlining runs before the content
hash, so a script left out of it would change the game without changing the
build id and every returning visitor would keep the cached copy.

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
worker normally, but `app.js` injects it as a plain `<script>` when constructing
a worker throws. Two classic scripts declaring the same top level `const` is a
SyntaxError, and `app.js` has its own `boxOf` and `PEERS`, so anything else
leaking out of that file breaks the fallback silently. `no-implicit-globals` in
`eslint.config.mjs` now enforces this rather than leaving it to memory.

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
npm run lint:fix        # all three linters, applying what they can fix
```

Three linters, wired into the hooks and CI. oxlint runs its `correctness` rules;
`eslint.config.mjs` reads `.oxlintrc.json` and switches off the rules oxlint
already covers; Biome lints and formats the JavaScript, which the other two only
see as text when it is inside `index.html`.

HTML indents four, the one place this tree is not on two. `.editorconfig`,
`biome.json` and `eslint.config.mjs` all say so and have to keep agreeing. Run
`npm run lint:fix` after editing anything, or watch CI fail on formatting.

The browser floor is Safari 15.4, so `Object.hasOwn` and optional chaining are
fine.

Two worktrees can run at once by setting `PLAYWRIGHT_PORT`.
