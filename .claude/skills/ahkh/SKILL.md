---
name: ahkh
description: Run, test, validate, debug or screenshot AutoHotkey v2 scripts (or any Windows GUI app) safely on a hidden desktop with the ahkh harness. Use whenever you need to execute an .ahk script, check whether it loads, catch its dialogs/errors/crashes, see what its window looks like, or verify a fix. Never launch AutoHotkey directly - a syntax error or MsgBox would pop up on the user's screen.
---

# ahkh — safe AutoHotkey v2 execution

`ahkh` runs targets on a **hidden Win32 desktop**: nothing can appear on the user's screen, take focus, move their mouse, or leave a process behind. Use it for every execution of a script, even a "quick check".

Invoke as `ahkh <verb>` if it is on PATH, otherwise `node C:\projects\ahk\AHKTestHarness\bin\ahkh.mjs <verb>` (bun works too). If the `ahkh_*` MCP tools are available, prefer them (same verbs, screenshots come back as images). First time on a machine: `ahkh doctor`.

## Hard rules
1. **Never run `AutoHotkey*.exe` (or any GUI target) directly** from Bash/PowerShell. Bash/MSYS also rewrites `/Validate` style switches into paths.
2. **Never edit the user's script just to test it.** Use `--patch <recipe>` (shadow copy) or `--probe` (injected via `/include`).
3. **Never kill processes by name** - the user runs their own AHK scripts. The harness only kills its own jobs.
4. Wait for conditions (`wait window|output|dialog|idle|exit|text`), never fixed sleeps.

## Pick the verb
| goal | command |
|---|---|
| does it load / syntax errors? | `ahkh validate <file\|folder>` (AutoHotkey's own parser = ground truth) |
| run once, see errors/dialogs/crashes | `ahkh run x.ahk` (exits by itself) · `ahkh run x.ahk --for 5` (long-running: observe 5s) |
| keep going past AHK error dialogs | add `--keep-going` |
| structured runtime errors, no dialogs | add `--probe --probe-on-error exit` |
| look at its window(s) | `ahkh session.start x.ahk` then `ahkh shot` (see skill **ahkh-gui-session**) |
| lint many files | skill **ahkh-lint** |
| find bugs automatically | skill **ahkh-smoke-test** |
| change/instrument without editing | skill **ahkh-modify-instrument** |

## Reading results
- First line: `VERDICT  label  (duration)  summary`. Worst-first: `FOCUS-STOLEN LEAK CRASH HUNG ERROR TIMEOUT FAIL DIALOG PASS`. Exit codes: PASS 0, FAIL 1, ERROR 2, TIMEOUT 3, CRASH 4, HUNG 5, LEAK 6, FOCUS-STOLEN 7.
- Each finding: `kind: message [file:line]` (lines are mapped back to the original file even when patched). Kinds: `ahk-error load-error runtime-error ahk-warning assertion hung crash timeout exit-code dialog clipboard-touched`.
- Evidence folder `<project>/.ahkh/runs/<stamp>-<label>/`: `summary.md`, `result.json`, `events.jsonl`, `shots/`, `dialogs/`, `procs/main/stdout.txt`. Show it with `ahkh run.show latest`; one picture of all screenshots: `ahkh runs.sheet latest`.
- `--json` on any verb gives structured output.

## Semantics worth knowing
- `--for N` = "expected to keep running, observe N s, then stop"; `--timeout N` = "must exit within N s".
- AHK **runtime errors are dialogs**, not stdout. The harness detects them structurally (locale independent), screenshots them, and ends the script unless `--keep-going`.
- `MsgBox`/`InputBox`/file dialogs are answered automatically (default button / cancel) and recorded as `dialog` info findings; `--fail-on-dialog` is a config option (`failOnDialog`) if they should fail the run.
- Scripts that touch `A_Clipboard` may empty the real clipboard; the host restores it and reports `clipboard-touched` (warn).
- PowerShell splits `1,2,3` into three args; array options accept both forms.

Full playbook: `C:\projects\ahk\AHKTestHarness\AGENTS.md`; internals: `docs\ARCHITECTURE.md`.
