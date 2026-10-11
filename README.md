# Coverage Lens: Who Tests This

A VS Code extension that answers two questions from a **per-test coverage database**:

- **Which tests go through this code?** While you read C++ sources, each function shows the tests that reach it, like a `git blame` of tests.
- **Which tests should I run for my change?** From the working tree, the staged changes, a commit or a whole branch, it lists the tests that reach the functions you touched, most relevant first, and the touched functions no test covers.

The database is a SQLite file made by `coverage_db.py ingest` from LLVM source-based coverage: one `.profdata` per test, minus a startup baseline. Share the `.sqlite` file, or serve it over HTTP, and everyone points the extension at it.

## Install

macOS / Linux:

```sh
curl -fsSL -o /tmp/coverage-lens.vsix https://github.com/e-marchand/coverage-lens/releases/latest/download/coverage-lens.vsix && code --install-extension /tmp/coverage-lens.vsix
```

Windows (PowerShell):

```powershell
Invoke-WebRequest https://github.com/e-marchand/coverage-lens/releases/latest/download/coverage-lens.vsix -OutFile $env:TEMP\coverage-lens.vsix; code --install-extension $env:TEMP\coverage-lens.vsix
```

With the GitHub CLI:

```sh
gh release download -R e-marchand/coverage-lens -p coverage-lens.vsix -D /tmp --clobber && code --install-extension /tmp/coverage-lens.vsix
```

Or download `coverage-lens.vsix` from the [releases](https://github.com/e-marchand/coverage-lens/releases) and run **Extensions: Install from VSIX…**. Use `cursor` or `code-insiders` instead of `code` for those editors.

Requires VS Code 1.101 or later: the extension reads SQLite with the `node:sqlite` module built into VS Code, so there is no native module and nothing else to install.

## Set the database

Run **Coverage Lens: Select Coverage Database…** from the Command Palette, or click the button in the Coverage Lens side bar. You can give it:

- a **file**, such as `~/Desktop/coverage.sqlite`;
- a **URL**, such as `http://build-server:8888/coverage.sqlite`. The extension downloads the database once, then on each start downloads it again only if the server has a newer one (`ETag` / `Last-Modified`). Without network, it keeps the copy it already has.

Both are stored in the `coverageLens.database` setting, which you can also edit by hand. It accepts `~` and `${workspaceFolder}`. **Coverage Lens: Reload Coverage Database** reopens it after it changes.

## In the editor

| | |
|---|---|
| **CodeLens** above each function | `🧪 12 tests: TQueries, TString, ORDA +9`, or `no test reaches it`, or `no test, only 4D startup reaches it`. Click it to pick tests and copy their names. |
| **Current line**, at the end of the line | The same summary for the function under the cursor. Hover over it for the full list with counters and durations. |
| **Status bar** | `🧪 12 tests` for the function under the cursor. |
| **Gutter** (off by default) | Green: a test reaches the function. Grey: only 4D startup does. Red: nothing executes it. Turn it on with **Coverage Lens: Toggle Gutter Colors**. |
| **Function at Cursor** view | All the tests reaching the function, with their counters and durations. Copy or run them. |

"Counters" are the coverage counters a test hits in the function beyond what 4D startup alone hits: the more counters, the more of the function the test exercises.

Files are matched to the database by path suffix, so any checkout location works: `/Users/me/src/4D/Sources/Foo.cpp` matches `4D/Sources/Foo.cpp`.

## Tests for a change

In the **Tests for Changes** view, or from the Command Palette:

| Command | Changes considered |
|---|---|
| **Tests for Working Tree Changes** (also a 🧪 button in Source Control) | `git diff HEAD`: staged and unstaged |
| **Tests for Staged Changes** | `git diff --cached` |
| **Tests for a Commit…** | a commit picked among the last 50, against its parent |
| **Tests for Branch Changes** | everything since the merge base with `coverageLens.baseBranch` (default `origin/main`), working tree included |
| **Tests for Current File** | every function of the file in the editor |

A changed line selects the innermost function containing it; code inserted inside a function body selects that function. The view then lists:

- **Tests to run**, the ones hitting the most counters in the touched functions first, with the total known duration. Expand a test to see which touched functions it reaches.
- **Touched functions no test covers**: when this list holds your whole change, running the test suite proves nothing about it.
- **Touched functions with tests**, and the **changes the coverage build knows no function for** (new functions, declarations, headers without code, files outside the build).

Copy the test names, copy a **Markdown report** for a pull request, or run them: set `coverageLens.runCommand`, for example `python3 tu_manager.py run ${tests}`. `${tests}` is replaced by the names separated by spaces, `${testsComma}` by commas.

## Settings

| Setting | Default | |
|---|---|---|
| `coverageLens.database` | | File path or `http(s)://` URL of the database |
| `coverageLens.codeLens` | `true` | CodeLens above functions |
| `coverageLens.currentLine` | `true` | Annotation at the end of the current line |
| `coverageLens.gutter` | `false` | Gutter colors |
| `coverageLens.inlineTestNames` | `3` | Test names shown before `+N` |
| `coverageLens.baseBranch` | `origin/main` | Base of **Tests for Branch Changes** |
| `coverageLens.ignorePattern` | `(ThirdParty\|/Applications/Xcode\|/usr/include\|SDKs)` | Paths left out of test selection |
| `coverageLens.runCommand` | | Shell command to run tests |

## Limits

- Line numbers are those of the sources the coverage build was made from. If your checkout is far ahead of that build, functions may have moved and the annotations drift. Diffs use the *old* side of the change, which is usually close to the build.
- New functions are not in the database: changes in them are listed as unknown to the build.
- Coverage is per function: a test that reaches a function is listed even if it skips the lines you changed.

## The database

Tables used, as written by `coverage_db.py`:

| Table | Columns used |
|---|---|
| `files` | `id`, `path` (relative to the source root of the build) |
| `functions` | `id`, `name`, `demangled`, `file_id`, `start_line`, `end_line` |
| `tests` | `id`, `name`, `duration` (seconds, optional) |
| `hits` | `test_id`, `function_id`, `new_covered`: counters hit beyond the baseline |
| `baseline` | `function_id`, `covered`: counters 4D startup alone hits |

Template instantiations sharing a source span are folded into one function. The database is opened read-only.

## Development

```sh
npm install
npm test          # compiles, then runs the unit tests with node --test
npm run package   # builds coverage-lens-<version>.vsix
```

Press F5 in VS Code with this folder open to start an Extension Development Host.

## License

[MIT](LICENSE)
