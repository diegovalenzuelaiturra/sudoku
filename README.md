# sudoku
Sudoku :)

## Difficulty

A difficulty is the hardest technique a board needs, not how many numbers it
starts with. Piola falls to singles, Normal needs locked candidates, Peludo
needs pairs, and Brígido needs more than any of those. The generator digs a
board, grades it by solving it without ever guessing, and adjusts until the
grade matches. The clue count moves to get there, so it is not advertised.

The search is allowed to miss: the pares tier is a narrow band and it lands
beside it about one board in seven. What it will not do is lie about it. The end
of game summary reports the grade the board was measured at, along with the seed
it was built from, and feeding that seed back rebuilds exactly the same puzzle.

Grading and generation run in a worker, so choosing a difficulty no longer
freezes the page. If a browser refuses to make one, the same file is loaded into
the page and the board is built there instead.

## Previewing

```sh
npm run preview
```

Builds `_site` and serves it at <http://127.0.0.1:4173/sudoku/>.

Use this rather than `python3 -m http.server`. GitHub Pages publishes this
repository as a project site under `/sudoku/`, so a path that begins with a
slash resolves against a different repository in production and quietly 404s.
Serving the repository root at `/` hides that class of bug, serves the source
files instead of the ones the build publishes, and puts `.git`, `node_modules`
and `tests/` on the wire.

Set `PLAYWRIGHT_PORT` to move it, which is also how two worktrees preview or
run the browser suite at the same time:

```sh
PLAYWRIGHT_PORT=4174 npm run preview
```

## Testing

```sh
npm test           # unit suite, about half a second
npm run test:coverage   # the same suite, with the coverage floor CI enforces
npm run test:e2e        # Playwright, real Chromium and real WebKit
```

The coverage floor is 85 percent of lines, 75 of branches and 85 of functions,
set a few points below what the suite measures today so it catches a regression
rather than rounding noise. It only sees files a test actually loads, so it will
not notice a brand new script that nothing imports.

## Git hooks

Optional but recommended. The hooks lint the workflow files and run the unit
suite before a commit lands, which is faster than finding out from CI.

```sh
npm ci --ignore-scripts
npx prek install         # writes .git/hooks/pre-commit
```

No separate install: prek is a devDependency, so `npm ci` already put it in
`node_modules/.bin`. Then commits run
[actionlint](https://github.com/rhysd/actionlint) for workflow validity,
[zizmor](https://docs.zizmor.sh) for workflow security, and the unit suite. To
run everything once without committing:

```sh
npm run lint
```

The first run downloads a Go toolchain to build actionlint, which takes about
twenty seconds and is cached in `~/.cache/prek` afterwards.
[prek](https://github.com/j178/prek) is a Rust reimplementation of
`pre-commit` and reads the same `.pre-commit-config.yaml`, so plain
`pre-commit` works just as well if that is what you already have.
`npx prek update` bumps the hook revisions.

None of this is load bearing: `git commit --no-verify` skips it, and the `Lint`
job in CI runs the same hooks over every file on every pull request.

One trap. The unit test hook needs `npm` on the `PATH`, and a desktop git client
or an editor commit button does not load your shell profile, so a version
manager like nvm will not be set up for it. The hook then fails with
`No such file or directory (os error 2)`, which does not look like what it is.
Commit from a terminal, or point the client at a shell that loads node.
