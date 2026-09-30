# ahkh — guide for AI agents

`ahkh` runs AutoHotkey v2 scripts (and any Windows GUI program) on a **hidden Win32 desktop** and reports what happened.
Nothing you launch through it can appear on, or take focus from, the user's screen. Use it instead of launching scripts yourself.

## Hard rules
1. **Never run AutoHotkey (or any GUI target) directly** from a shell. A syntax error or `MsgBox` puts a dialog on the user's screen. Always go through `ahkh run | session.start | smoke | validate`.
2. **Never modify the user's scripts to test them.** Use `--patch` (shadow copy) or `--probe` (injected with `/include`). Originals are only ever edited by `lsp.format --write`, and only when asked.
3. **Never kill processes by name.** The user runs their own AHK scripts. The harness only ever kills its own job (`proc.kill`, `session.stop`).
4. Prefer **waits over sleeps**: `wait window|output|dialog|idle|exit|text`.
5. Screenshots are cheap and safe: take one whenever you are unsure what the UI looks like.

## Which verb?
| I want to… | verb |
|---|---|
| know if a script loads / has syntax errors | `validate <files>` (AHK's own parser, ground truth) |
| lint a project, compare AHK vs language server | `lint <folder>` · `lsp.check <folder> --format sarif` |
| run a script once and see errors/dialogs/crashes | `run <script> [--for N] [--keep-going] [--probe]` |
| explore a GUI step by step | `session.start <script>` → `tree` / `marks` / `shot` / `click` / `press` / `type` … → `session.stop` |
| find bugs in an unknown GUI automatically | `smoke <script>` (then `replay`, `reduce actions`) |
| minimise a failing script | `reduce script <file> --match "<regex>"` |
| temporarily change a script | `patch <script> --patch <recipe> --diff`, or `run … --patch <recipe>` |
| go to definition / references / hover | `lsp.def file:line:col`, `lsp.refs`, `lsp.hover`, `lsp.symbols` |
| see the include graph | `includes <script>` |
| time a script / find flakes | `bench`, `repeat`, `matrix` |
| call script functions / read globals | `session.start … --probe` then `call`, `var`, `guis`, `fire`, `hotkey.list`, `hotkey.fire` |
| prove the harness itself works | `selftest` |

`ahkh help` lists everything; `ahkh help <verb>` shows options. Add `--json` for machine-readable output.

## Output you can rely on
- First line: `VERDICT  label  (duration)  summary`. Verdicts, worst first: `FOCUS-STOLEN LEAK CRASH HUNG ERROR TIMEOUT FAIL DIALOG PASS`.
- Exit codes: `PASS 0 · FAIL 1 · ERROR 2 · TIMEOUT 3 · CRASH 4 · HUNG 5 · LEAK 6 · FOCUS-STOLEN 7`.
- Every run leaves a folder (`<project>/.ahkh/runs/<stamp>-<label>/`): `summary.md`, `result.json`, `events.jsonl` (every event, timestamped), `shots/`, `dialogs/`, `procs/<name>/stdout.txt|stderr.txt`, `effective/` (patched sources + `linemap.json`), `smoke-*.json`. `ahkh run.show latest`, `ahkh runs`, `ahkh runs.sheet latest` (one contact-sheet image of all screenshots).
- Findings have `kind`: `ahk-error`, `load-error`, `runtime-error`, `ahk-warning`, `assertion`, `hung`, `crash`, `timeout`, `exit-code`, `dialog` (info), `clipboard-touched`, `lsp-*`, `guard-*`.
- Line numbers of errors in patched scripts are mapped back to the original file.

## Driving a GUI (session workflow)
```
ahkh session.start app.ahk --probe            # hidden desktop + script (+ in-process probe)
ahkh windows                                  # w1 …
ahkh tree                                     # w1.0 text … w1.4 button "Save" …  (refs are valid until the UI changes)
ahkh marks w1                                 # screenshot with numbered boxes + legend → pick by number/ref
ahkh press "button:Save"                      # selectors: button:Text · class=Edit · text~=regex · id=7 · index=N · w1.4 · 0xHWND
ahkh type w1.1 "hello" ; ahkh check w1.2 --state true ; ahkh select w1.3 --index 2
ahkh wait dialog --timeout 5 ; ahkh wait output "saved"
ahkh shot w1 --rect 10 140 410 40 --scale 2   # closeup, magnified
ahkh guis ; ahkh fire --ctrl c7 --event Click # AHK-level: errors return structured, no dialog
ahkh session.stop                             # verdict + evidence
```
Input is **message based** (never `SendInput`): it cannot move the real mouse or steal focus. Hotkeys are fired with `hotkey.fire` (posts `WM_HOTKEY`), not by typing keys.
Dialogs the script opens are handled automatically by the **rule engine** (`rules/default.json`): AHK errors are recorded with a screenshot and end the script (or `--keep-going` presses Continue), `MsgBox`/`InputBox`/file dialogs are answered and recorded. Add rules with `--rules '[{"match":{"title":"Confirm"},"do":{"press":{"id":7}}}]'` or in `ahkh.json`.

## Loops that work well
- **Fix loop:** `validate`/`lint` → edit → repeat until PASS.
- **Bug hunt:** `smoke app.ahk` → read `summary` → `reduce actions app.ahk --actions <run> --match "<regex>"` → `replay` to confirm → fix → `smoke --seed <same>` to verify.
- **Instrument, don't edit:** `run x.ahk --probe --probe-on-error exit` (structured errors, no dialogs), or `patch` recipes (`stub-dangerous`, `fast-sleep`, `warn-stdout`, `no-exit`).

## Gotchas learned the hard way
- **PowerShell turns `1,2,3` into three arguments.** Array options like `--rect` accept either form.
- **Git Bash rewrites `/Switch` arguments** (`/Validate` → `C:/Program Files/Git/Validate`). Run AHK only through the harness, or use PowerShell.
- **AutoHotkey honours exactly one `/include`** (two → exit code 2, no message). The harness merges injections into one prelude file.
- `Error(msg, -1)` in an event handler reports a misleading line; the harness reports what AHK says.
- UIA `Invoke`/`Toggle` fail on plain Win32 buttons on a non-input desktop; use `press`/`check`. UIA is great for inspection and `setvalue`.
- Scripts that use `A_Clipboard` can *empty* the user's clipboard (the job limit only stops writes). The host restores it within milliseconds and reports `clipboard-touched` (warn). See `docs/ARCHITECTURE.md`.
- `--for N` = "expected to keep running, observe N seconds"; `--timeout N` = "expected to exit, fail if it doesn't".
- AHK runtime errors are **dialogs**, not stdout, unless a probe with `AHKH_ONERROR` is injected.

## Extending
- New dialog behaviour → `rules/*.json` / `ahkh.json`. New script transformation → `patches/*.json`. New workflow → `profiles/*.json` (`ahkh profile <name> <targets>`). New verb → `lib/verbs/*.mjs` with `defineVerb` (it becomes a CLI verb, an MCP tool and a hub RPC automatically). Native features → `native/*.cs` (C# 5, `build.ps1`).
