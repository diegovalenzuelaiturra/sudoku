# Working in this repository

A Sudoku game in Spanish. Static, no runtime dependencies, published to GitHub
Pages. The conventions below are not style preferences: each one is either
enforced by a test or exists because breaking it shipped a bug.

## What ships

Six things reach the browser: `index.html`, `404.html`, `manifest.webmanifest`,
`sw.js`, `generator.js` and `icons/`. `index.html` is the whole interface, with
its styles inline.

Two more files are loaded by `index.html` and published by neither name:
`app.js`, which is the game, and `stats.js`, which is the arithmetic behind the
progress block. `index.html` loads them with `<script src="app.js">` and
`<script src="stats.js">`, and `scripts/build.mjs` folds both back into the
page, so what ships is still one file. They live apart so the linters read them
as JavaScript rather than as text inside markup, which is where `app.js` used to
be and where nothing checked it, and so node can require `stats.js` and the
coverage report can see it. Add another such file to `INLINED_SCRIPTS` in
`scripts/build.mjs`, not to the allowlist: inlining runs before the content
hash, so a script left out of it would change the game without changing the
build id and every returning visitor would keep the cached copy.

Adding a published file means adding it in three places. One direction is
checked: `tests/assets.test.mjs` walks `PUBLISHED` and fails when `ALLOWLIST`
omits an entry, so an `ALLOWLIST` entry with no `PUBLISHED` line passes. Nothing
compares `APP_SHELL` with either list, so `404.html` and `sw.js` ship today
without being precached and the suite stays green:

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
`eslint.config.mjs` enforces this.

**Comments are load bearing.** Several exist specifically to stop a fixed bug
being reintroduced, and they record measurements that were expensive to take.
The published copy is stripped by the minifier, so keeping them costs nothing.
Explain why, not what.

## Branches and releases

Feature work branches off `development`, arrives by pull request and is squash
merged, so `development` stays a flat chain of one commit per pull request.

**A release is a merge commit, never a squash.** The release pull request takes
`development` into `main`, and its second parent is the only thing that makes
the individual commits ancestors of `main`. Release #27 was squash merged by
mistake, flattening six commits into one that nothing pointed at. That diverged
the two branches, cost a repair pull request (#36) whose entire job was to graft
the ancestry back while changing no files, and left one opaque lump in main's
history that cannot be undone now. The `main protection` ruleset allows only the
merge method, so the button can no longer get this wrong.

**After a release merges, fast-forward `development` onto `main`.**

```sh
git switch development && git merge --ff-only main && git push origin development
```

Both branches then sit on the same commit and the next release starts from
common ground. The push is refused at first: `development protection` requires
`Test`, `Lint` and the code scanning results on the exact commit being pushed,
and those runs start only once the merge commit is on `main`. Every gating
workflow carries a `push: branches: [main]` trigger for that reason. Retry the
push every minute until it lands, and never force past it.

Skipping the fast-forward is what turned one mis-click into three releases of
drift: once the branches had diverged the fast-forward was impossible, so it
stopped happening, and `development` trailed `main` by every release merge.
Development's ruleset deliberately has no pull request rule, because that would
demand a pull request for this push, and a fast-forward cannot be delivered
through one.

## How the game is put together

Difficulty is the hardest technique a board needs, not its clue count. The
ladder is in `generator.js`: directas, bloques, pares, avanzado. The clue counts
in `DIFF` are only where the search starts, and the generator moves them to
reach a grade, so nothing may advertise a fixed number of clues. The grade a
board is reported at is always the grade it was measured at, never the one that
was requested: the search is allowed to miss, and the player is told the truth.

Every board is a pure function of a 32 bit seed, so a puzzle can be rebuilt from
the code shown at the end of a game. `tests/generator.test.mjs` and
`tests/oracle.test.mjs` drive 24 seeds written down once, which makes a hit rate
a constant and any drop in it a regression. `tests/properties.test.mjs` draws
seeds across the whole 32 bit space with fast-check and shrinks a failure to the
smallest seed that still breaks.

Five localStorage keys, each versioned: `sudoku:save`, `sudoku:wallet`,
`sudoku:stats`, `sudoku:history` and `sudoku:prefs`. The wallet and the history
share one rule. A reader that cannot make sense of what is stored leaves the
bytes where they are, because they probably belong to a newer build the player
still has cached. The wallet is the stricter of the two, since what is in it was
earned: it reads its own version and the one before, refuses anything newer, and
never writes over what it refused. `sudoku:history` follows it, because it is
the ring of finished games and a game that was played cannot be played again.
`sudoku:save`, `sudoku:stats` and `sudoku:prefs` start over on a version they
do not know, and the next write replaces the bytes they refused to read: a lost
streak is not a lost prize, and a setting that cannot be read is a setting to
ask for again.

## Tests

```sh
npm test                # unit, a few seconds
npm run test:coverage   # the same, with the floor CI enforces
npm run test:e2e        # Playwright, real Chromium and real WebKit
npm run lint            # the git hooks, over every file
npm run lint:fix        # all three linters, applying what they can fix
```

Four checks, wired into the hooks and CI. oxlint runs its `correctness` rules;
`eslint.config.mjs` reads `.oxlintrc.json` and switches off the rules oxlint
already covers; Biome lints and formats the JavaScript, which the other two only
see as text when it is inside `index.html`; cspell reads the Spanish copy in
`index.html`, `app.js` and `404.html`. `npm run lint:fix` drives the first three,
because cspell has no fix mode.

HTML indents four, the one place this tree is not on two. `.editorconfig`,
`biome.json` and `eslint.config.mjs` all say so and have to keep agreeing. Run
`npm run lint:fix` after editing anything, or watch CI fail on formatting.

The browser floor is Safari 15.4, so `Object.hasOwn` and optional chaining are
fine.

Two worktrees can run at once by setting `PLAYWRIGHT_PORT`.
