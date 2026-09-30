---
name: ahkh-modify-instrument
description: Temporarily change or instrument an AutoHotkey v2 script without editing it, using ahkh - patch recipes on a shadow copy (stub dangerous calls, fast-forward Sleep, route #Warn to stdout, custom regex/insert ops), the in-process probe (assertions, chained OnError, GUI recorder, micro-benchmarks), tracing, and bench/repeat/matrix. Use to make a script safe or deterministic for testing, to add assertions, to time it, or to see what it actually calls.
---

# Modify and instrument without touching the original

## Patch recipes (shadow copy; originals never modified)
```
ahkh patches                                          # list recipes: stub-dangerous  fast-sleep  warn-stdout  warn-all  no-exit
ahkh patch app.ahk --patch fast-sleep --diff          # dry run: shows the unified diff + effective entry path
ahkh run   app.ahk --patch stub-dangerous --patch warn-stdout --for 5
ahkh session.start app.ahk --patch fast-sleep --overlay
```
The run folder keeps `effective/` (patched sources, `patch.diff`, `linemap.json`); error lines are reported against the **original** file. Only executable code is rewritten - strings, comments, block comments and continuation sections are left alone. Out-of-tree `#Include`s are made absolute. Copy cap: 6000 files / 250 MB.

Write your own in `patches/<name>.json` (project or harness) or inline JSON:
```json
{ "name": "no-updates", "ops": [
  { "op": "replace", "file": "*", "regex": "CheckForUpdates\\(\\)", "with": "0" },
  { "op": "prepend", "file": "entry", "text": "#Warn All, StdOut" },
  { "op": "insertAfter", "file": "entry", "match": "^Main\\(\\)", "text": "Ahkh.Log(\"main done\")" },
  { "op": "stub", "file": "*", "calls": ["MsgBox"], "returns": "\"OK\"" } ] }
```
Ops: `replace{regex|find,with,count,line,code:false}`, `prepend`/`append{file,text}`, `insertBefore`/`insertAfter{match,text,once}`, `delete{match}`, `include{path}`, `stub{calls[],returns|body,params,quiet}`. `file`: `entry` | glob | `*`. Inline: `--patch '{"op":"replace",...}'`.

## The probe (`--probe`)
Injected with AutoHotkey's `/include` (no edit; only one `/include` exists, the harness merges). Class `Ahkh` in your script:
```ahk
Ahkh.Assert(cond, "msg")   Ahkh.Expect(actual, expected, "msg")   Ahkh.Step("name", () => ...)
Ahkh.WaitFor(() => cond, 5000)   Ahkh.Log("x")   Ahkh.Mark("label")   Ahkh.Done()      ; exit 1 if anything failed
Ahkh.Bench("label", () => Work(), 1000)   Ahkh.Time("label", () => Work())              ; -> AHKH|bench lines
```
Run with `ahkh run t.ahk --probe` (passive mode: never changes when the script would exit): failed assertions/steps and runtime errors become findings with file:line. `--probe-on-error log|exit|continue` decides what happens after an error is reported (`exit` = no dialog, ends the script). For a script under test, `#Include C:\projects\ahk\AHKTestHarness\ahk\AhkProbe.ahk` also works.
With `session.start --probe` (rpc mode) you also get `guis`, `fire`, `call`, `var`, `hotkey.list`, `probe <cmd>`.
Stdout protocol if you need it: lines `AHKH|<kind>|<json>` (error assert step done log mark bench).

## Measure and compare
```
ahkh bench app.ahk --runs 7 --for 3 --csv bench.csv   # time-to-first-window, idle, working set, handles, CPU (median/min/max) + Ahkh.Bench results
ahkh repeat app.ahk --count 10                          # verdict distribution, flake rate
ahkh matrix app.ahk --env '[{"LANG":"de"},{"LANG":"ja"}]' --argsets '[[],["--debug"]]'   # 64-bit and 32-bit AutoHotkey x env x args
ahkh trace app.ahk --for 5 [--lines]                    # AST TraceWrapper: what was called, how often, how long, errors (graceful close so OnExit writes the dump)
ahkh ast.flow app.ahk minify-safe | beautify | treeshake-safe | eval-analysis   # other AST transforms, output under the run folder
```
Wall-clock timings on a busy machine are noisy: use several runs and read the median.

## Rules of thumb
- Prefer `--probe` / `--patch` over editing; if you must edit the real file, say so.
- `stub-dangerous` replaces FileDelete/FileRecycle/DirDelete/DirMove/FileMove/RegDelete/RegDeleteKey/RegWrite/Run/RunWait/RunAs/ProcessClose/WinKill/Shutdown with logged no-ops - use it whenever running an unfamiliar script.
- Timers/OnMessage callbacks can't be intercepted at runtime (a script can override a built-in but not reach the original): call them by name with `call`.
