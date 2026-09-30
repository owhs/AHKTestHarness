---
name: ahkh-gui-session
description: Drive an AutoHotkey v2 GUI (or any Win32 app) step by step on the hidden desktop with ahkh - list windows and controls, take screenshots and closeups, click/type/select/press, wait for dialogs, fire hotkeys, call script functions, read variables. Use when you need to see or interact with a script's window, reproduce a UI bug, or verify a UI change, without showing anything on the user's screen.
---

# Driving a GUI with ahkh sessions

A session = one hidden desktop + your app + an evidence folder, kept alive between commands (a small local hub process holds it; MCP holds it in-process). Commands: prefix with `ahkh ` (or `node C:\projects\ahk\AHKTestHarness\bin\ahkh.mjs `), or use the `ahkh_*` MCP tools.

## Workflow
```
ahkh session.start app.ahk --probe        # --probe enables guis/fire/call/var/hotkey.list; --overlay runs a shadow copy
ahkh windows                              # w1 = main window ...
ahkh tree                                 # w1.4 button "Save" ... (kind, text, state, rect)
ahkh marks w1                             # screenshot with numbered boxes + legend -> choose by number/ref
ahkh press "button:Save"                  # message-based BM_CLICK (never the real mouse)
ahkh type w1.1 "hello"                    # WM_CHAR   |  ahkh text w1.1 "replace all"  (sets text + notifies)
ahkh check w1.2 --state true              # checkbox/radio
ahkh select w1.3 --index 2                # combo/list (or --text Beta)
ahkh wait dialog --timeout 5              # or: wait window <title-regex> | output <regex> | idle | exit | text <regex>
ahkh shot w1 --rect 10 140 410 40 --scale 2   # magnified closeup (x y w h relative to the window)
ahkh shot --desktop                       # everything on the hidden desktop
ahkh burst --count 6 --every 300          # N shots stitched into one contact sheet with timestamps
ahkh session.stop                         # verdict + evidence bundle
```

## Targets (any command that takes one)
`w1` / `w1.4` refs (assigned when windows/controls are listed; resolved on demand) · `0xHWND` · selectors: `button:OK` (kind:text), `class=Edit`, `text~=regex`, `id=7`, `kind=checkbox&text~=Verbose`, `...&index=N` · `proc:name`. Omit the target for the main window.

## Inspect
`windows`, `tree [--all]`, `uia` (UI Automation: names, automation ids, patterns, values), `find <selector>`, `at <x> <y>` (what is at a screen point), `metrics` (memory/handles/GDI/USER counts), `findings`, `events --kind out` (script stdout timeline), `status`.

## Script-level driving (needs `--probe`)
`guis` (every Gui/control the script built, names, values, wired events) · `fire --ctrl c7 --event Click` (runs the handler *inside* the script; errors return structured, no dialog) · `call FunctionName '[1,2]'` · `var globalName` (`var name <json>` writes) · `hotkey.list` · `hotkey.fire 2` or `hotkey.fire --all 8` (posts WM_HOTKEY: no keyboard involved) · `probe menus` / `probe menufire`.

## Dialogs
Opened automatically-handled: AHK error dialogs are recorded (+ screenshot) and end the script unless `session.start --keep-going`; MsgBox/InputBox/file dialogs are answered and recorded. Custom handling: `--rules '[{"match":{"title":"Confirm"},"do":{"press":{"id":7}}}]'`.

## Limits and gotchas
- UIA `uia.act invoke/toggle` fails on plain Win32 buttons on this desktop -> use `press`/`check`; `uia.act --action setvalue` works.
- Real key chords (Ctrl+A etc.) cannot be synthesised; use `text`, `key` (posts WM_KEYDOWN/CHAR), or `hotkey.fire`.
- Refs go stale when the UI changes; re-run `tree`/`find` after a click that changes the layout.
- Non-AHK app: `ahkh session.start --exe C:\path\app.exe` (everything except the probe verbs works).
- Always `session.stop` (the hub also cleans up if the controller dies).
