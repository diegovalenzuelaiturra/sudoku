# sudoku
Sudoku :)

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
