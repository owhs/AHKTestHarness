---
name: ahkh-lint
description: Lint, validate and statically analyse AutoHotkey v2 code with ahkh - AutoHotkey /Validate, the thqby language server (diagnostics, symbols, go-to-definition, references, hover, completion, format, rename), include graphs, the AST outline, with text/JSON/SARIF/JUnit/GitHub output and baselines for CI. Use to check syntax, find undefined/unset variables, follow symbols across files, or gate a commit, without executing anything on the user's desktop.
---

# Lint and static analysis with ahkh

Ground-truth order: **AutoHotkey `/Validate` > language server > AST parser** (experimental). `ahkh lint` shows all opinions side by side.

## Commands
```
ahkh validate <files|folders|globs>            # AHK loads the script (no run) inside the sandbox; load errors/warnings with line numbers
ahkh lsp.check src --min-severity warning      # language-server diagnostics (syntax, undefined/unset vars, param counts, unreachable code)
ahkh lint src                                  # 3-way: AHK vs LSP per file -> both-error | LSP-ONLY (false positive?) | LSP-MISSED | clean
ahkh includes app.ahk                          # #Include graph: resolved / missing / *i optional / cycles / <Lib> lookups
ahkh ast.outline app.ahk [--includes]          # functions(params), classes(members), hotkeys, hotstrings, globals, includes
ahkh ast.check src                             # parse problems as the AST engine sees them
```
Navigation (positions are `file:line:col`, 1-based):
```
ahkh lsp.symbols file.ahk        ahkh lsp.def file.ahk:12:5      ahkh lsp.refs file.ahk:12:5
ahkh lsp.hover file.ahk:12:5     ahkh lsp.complete file.ahk:12:5 ahkh lsp.rename file.ahk:12:5 --to newName   # dry run: lists edits
ahkh lsp.format file.ahk --check           # would it change?   (--write edits the file IN PLACE: only when asked)
```

## CI / team use
```
ahkh lsp.check src --format sarif --out lint.sarif           # also: json | junit | github (annotations) | text
ahkh lsp.check src --baseline .ahkh/lint-baseline.json --update-baseline   # accept current state once
ahkh lsp.check src --baseline .ahkh/lint-baseline.json                     # then only NEW diagnostics fail (keys ignore line shifts)
ahkh profile quick src                                      # validate + lsp.check(errors only); profiles: lint smoke quick ci
```
Exit code is non-zero when there are errors.

## Options and behaviour
- `--unused` adds unused-symbol warnings; `--no-unset` silences "never assigned" warnings; settings can also live in `ahkh.json` -> `lsp.settings` (e.g. `Warn`, `Diagnostics.InvokeCheck`, `Files.MaxDepth`).
- The language server runs **inside the hidden desktop** (its AutoHotkey child process too), so nothing can pop up. Cold start ~0.5-1s; keep it warm with the hub (`--hub`) for many calls.
- Semantic diagnostics only appear after the server has been asked for symbols; the client handles that (a clean file publishes nothing - that means zero diagnostics).
- Workspace root = folder of the first file (`--root` to change) - it decides cross-file symbol resolution.
- `LSP-ONLY` disagreements are usually false positives (dynamic code); `LSP-MISSED` means AHK failed but the server didn't - trust AHK.
- Line numbers refer to the file as written; nothing is executed by these verbs except AHK `/Validate` in the sandbox.

## Typical fix loop
`ahkh validate x.ahk` -> read `file:line  message` -> edit -> repeat until PASS -> `ahkh lint .` for the fuller picture -> optionally `ahkh run x.ahk --for 3` to confirm it also *runs* (loading is not running: `/Validate` misses runtime errors).
