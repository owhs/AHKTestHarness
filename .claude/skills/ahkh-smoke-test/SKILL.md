---
name: ahkh-smoke-test
description: Automatically smoke-test an unknown AutoHotkey v2 GUI script with ahkh - it discovers controls, menus, hotkeys and timers, clicks/types/fuzzes everything on a hidden desktop (skipping dangerous-looking buttons), and reports errors, dialogs, hangs and leaks; then replay and minimise failures. Use to find bugs in a script you did not write, to regression-check after a change, or to get a minimal repro of a crash.
---

# Automatic smoke testing

```
ahkh smoke app.ahk                       # defaults: 60s budget, 150 actions, seed 1
ahkh smoke app.ahk --budget 120 --seed 7 --max-actions 300
ahkh smoke app.ahk --level discover      # static | boot | discover | poke  (stop early)
```
What it does: (S0) static scan - includes, language-server errors, hotkeys/timers/dangerous calls; (S1) boot on a **shadow copy** with the probe and `stub-dangerous` patch (FileDelete/RegWrite/Run/... become logged no-ops); (S2) discover controls, menus, hotkeys, timers; (S3-S5) poke: press buttons, toggle checks, select list/combo items, fuzz edits (empty, huge, unicode, quotes, `%`, paths...), fire every hotkey via WM_HOTKEY, menu handlers, timer callbacks, resize/min/max/restore, close the window - and follow newly revealed UI (tabs, windows); (S4) after every action record new windows, dialogs, errors, stdout, hangs; screenshots on change; leak trend (handles/GDI/working set).

Safety: buttons/menus matching the deny-list (`delete|remove|erase|format|uninstall|reset|shutdown|send|submit|pay|buy|...`) are **skipped and listed**; message boxes get the least destructive answer (Cancel/No before OK; never Yes); originals are untouched. Override with `--deny <regex>`, `--allow <regex>`; `--unsafe` disables the stubs; `--in-place` skips the shadow copy (writes then hit the real files - avoid).

## Reading the result
Summary line: actions, controls poked/total, hotkeys fired, dialogs, errors; then findings (each with the action number that caused it); skipped labels; leak deltas. Artifacts in the run folder: `smoke-surface.json` (everything discovered), `smoke-report.json` (coverage, state graph, unpoked controls), `smoke-actions.jsonl` (replayable log), `shots/`. `ahkh runs.sheet latest` shows all screenshots in one image. The same `--seed` reproduces the same order.

## Then: reproduce, minimise, fix, verify
```
ahkh replay app.ahk --actions <run-name>                               # confirm the bug replays in a fresh session
ahkh reduce actions app.ahk --actions <run-name> --match "regex of the error message" --budget 300
ahkh reduce script  app.ahk --match "regex"                            # fewest LINES that still give that exact finding (add --run for runtime bugs)
# fix the script, then:
ahkh smoke app.ahk --seed <same seed>                                  # same actions, should be clean
```
Reducers lock onto the *signature* of the original finding (numbers/paths normalised), so they will not drift to a different bug. Trials that don't reproduce (timing-dependent) report `NOREPRO` - re-run or lower `--budget` noise by seeding.

## Tips
- Long-running/non-GUI scripts: `smoke` still runs static + boot; with no GUI it ends after boot/discover.
- Timer callbacks are found statically and called by global function name; `SetTimer` with lambdas can't be called.
- Hotkey ids are definition order (`hotkey.list` shows it); hotkeys that open dialogs are answered safely.
- Combine with `ahkh repeat` for flakiness and `ahkh bench` for startup cost.
