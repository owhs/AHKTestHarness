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
| see EXACTLY what the user's screen would show (overlays, alpha, 3D, thumbnails) | `shot --desktop` (composed by default) · `shot w1 --composed` · `shot w1 --composed --isolate` · from inside the script: `Ahkh.Shot()` |
| hover / click a screen point like a real mouse (click-through overlays, hover) | `mouse move\|click\|double\|wheel X Y` |
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

### Seeing what the user would see (composed screenshots)
```
ahkh shot --desktop                         # composed (the default for the desktop): every window rendered by DWM, z-order, over the wallpaper
ahkh shot --desktop --bg checker --max-edge 0        # 1:1 pixels, checkerboard where nothing is   (--bg wallpaper|checker|transparent|#RRGGBB)
ahkh shot w1 --composed                     # the screen inside w1's rectangle: overlays ABOVE it and whatever shows through it
ahkh shot w1 --composed --isolate           # only w1, with its real per-pixel alpha (over --bg, default checker)
```
From inside the script (any `--probe` run): `r := Ahkh.Shot("C:\x\after.png")` or `Ahkh.Shot(path, Map("hwnd", g.Hwnd, "rect", [0, 0, 400, 100], "scale", 2))` returns a Map (path, width, height, layers, unreadable); synchronous, the host renders while the script waits. Raw: `ahkh probe shot`.
The summary says how each window was obtained (`dwm-thumbnail`, `redirection-surface`) and lists **unreadable** windows (drawn hatched magenta): a layered window excluded from capture (`SetWindowDisplayAffinity`). With `--probe` the probe lifts its own exclusions for the moment of the shot and restores them ("probe lifted the capture exclusion of N window(s)").
Shows: UpdateLayeredWindow overlays with their alpha, DirectComposition trees (incl. dwmapi #147 shared thumbnails, 3D), DWM thumbnails, Trident pages, caption/border colours, rounded corners, windows excluded from capture. Does not: Mica/acrylic come out as their solid (inactive) colour; no window shadows; **Direct2D/DXGI apps that skip drawing while "occluded"** (a non-input desktop counts as occluded) show only what they drew with GDI, e.g. Notepad++'s DirectWrite editor is empty: switch it to GDI with `ahkh msg <scintilla ref> --msg 2630 --wparam 0 --send`.
The old GDI shots (`--tech composite|printwindow`) can't see any of that. Never `PrintWindow` an UpdateLayeredWindow window yourself: it *replaces* the overlay's content (the harness refuses to).

### The synthetic mouse
`ahkh mouse move 400 300`, `ahkh mouse click 400 300 [--button right]`, `double`, `down`, `up`, `wheel --delta -120` (screen coordinates). The point is routed by the hidden desktop's own `WindowFromPoint` (alpha-0 pixels and click-through layered windows fall to the window below: the summary says `passed through …`), then `WM_NCHITTEST` (HTTRANSPARENT walks on), `WM_SETCURSOR`, `WM_MOUSEMOVE`, `WM_MOUSELEAVE` to the window it left, buttons, wheel. Caption buttons become `WM_SYSCOMMAND`; caption/border drags are refused (DefWindowProc's modal loop would wait for real input).
On a non-input desktop `GetCursorPos` fails (MouseGetPos returns garbage). With `--probe` the script's `GetCursorPos` reads the synthetic cursor instead (probe log `"cursor":"synthetic"`), so hover logic and ToolTip placement work.
Cannot be simulated: low-level hooks (`WH_MOUSE_LL` / `WH_KEYBOARD_LL`, so AHK's hook hotkeys and mouse hotkeys) only see real input on the input desktop: use `hotkey.fire`. Also `GetAsyncKeyState`/`GetKeyState` of buttons, raw input, real drags.
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
- `wait output ready` also matches the probe's own `probe ready` log line: anchor it (`wait output "^ready$"`).
- Screenshots default to `--max-edge 1400` (config `shots.maxEdge`); pass `--max-edge 0` for 1:1 pixels.
- `call` takes `Class.Method` too (`ahkh call Reskin.Composite [21302156] --timeout 30`).
- `--for N` = "expected to keep running, observe N seconds"; `--timeout N` = "expected to exit, fail if it doesn't".
- AHK runtime errors are **dialogs**, not stdout, unless a probe with `AHKH_ONERROR` is injected.

## Extending
- New dialog behaviour → `rules/*.json` / `ahkh.json`. New script transformation → `patches/*.json`. New workflow → `profiles/*.json` (`ahkh profile <name> <targets>`). New verb → `lib/verbs/*.mjs` with `defineVerb` (it becomes a CLI verb, an MCP tool and a hub RPC automatically). Native features → `native/*.cs` (C# 5, `build.ps1`).
