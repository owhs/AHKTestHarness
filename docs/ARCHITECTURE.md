# Architecture, protocols and findings

## Layers
```
CLI (bin/ahkh.mjs)   MCP server (ahkh mcp)   hub daemon (TCP, token)      <- all call the same verbs
        +-------------- lib/verbs/*.mjs  (defineVerb: one definition = CLI verb = MCP tool = hub RPC)
                              |
                lib/session.mjs  Session = evidence Run + native host + processes + state (windows, dialogs, shots, findings)
                              |  JSON lines over stdio
                native host  bin/ahkh-host.exe  (C#, csc .NET 4, winexe: no console window)
                  - desk thread: SetThreadDesktop(hidden desktop); ALL window ops run here; 20ms watcher tick
                  - mon thread : stdout/stderr tail, exit, deadline
                  - guard thread + clipboard guardian (interactive session)
                  - per-target Job Object (kill-on-close, memory cap, UI limits): started suspended -> assigned -> resumed
                              |  lpDesktop = "WinSta0\AHKH_<pid>_<rand>"
                target processes (AutoHotkey, or anything)  <- optional AhkProbe.ahk via one /include
```
JS has **no npm dependencies**; it runs on node >= 18 and bun. The host dies with its controller (stdin EOF -> `Shutdown`; jobs are kill-on-close), verified by selftest and by killing the hub mid-session.

## Host protocol (`bin/ahkh-host.exe`)
Requests `{"id":1,"cmd":"win.list","proc":"main"}` -> `{"id":1,"ok":true,"result":...}` or `{"id":1,"ok":false,"error":"..."}`. Events (no id): `ready proc.start proc.exit proc.timeout out win.new win.ready win.gone win.hidden dialog shot hung unhung guard error`, each with `t` (ms since host start) and `ts`.
Commands: `proc.start|kill|info|list|metrics|deadline|dispose`, `rules.set`, `shots.auto`, `shot`, `win.list|tree|at|click|press|text|key|type|select|check|close|wmclose|minimize|maximize|restore|move|msg`, `uia.tree|act`, `guard.report|reset`, `clip.config`, `desk.info|list`, `sys.snapshot`, `img.info|crop|sheet|diff|annotate|pixel|dominant` (the image commands also work with `--images-only`, no desktop).
NB: `id` is the request id; process names travel as `proc`.

## Dialog rules
`{name, match:{kind,class,title,text,button,proc}, do:{shot,press,type,close,kill,ignore,delayMs,verdict}}`, first match wins, user rules before `rules/default.json`. `press`: `"default" | "safe" | "first" | "kill" | "close" | "<button text>" | {id:N} | {button:"..."}`.
Kinds are structural: AHK v2's error dialog owns a RichEdit (id 501) and buttons 65400/65401/65405/65411 (Reload/Edit/ExitApp/Help); warnings are the same dialog with Abort (id 2) hidden. Locale independent. `safe` = Cancel, No, Abort, Ignore, Continue, OK - never Yes/Retry (used by smoke).

## Probe protocol
Stdout lines `AHKH|<kind>|<json>` (`error assert step done log mark bench`). RPC (rpc mode only, so a permanent timer never changes when a script would exit): mailbox files `probe/in/NNNNN.json` -> `probe/out/NNNNN.json`, polled every 40ms inside the target. Commands `ping guis menus menufire hotkeys fire call get set log exit`. Wrappers installed via `DefineProp` on `Gui.Prototype.*`, `Gui.Control.Prototype.OnEvent`, `Gui.Prototype.OnEvent`, `Menu.Prototype.Add` record what the script builds; `fire` runs handlers *inside* try/catch so errors come back structured.

## Findings from spikes (verified in the sandbox, AutoHotkey 2.0.19)
| question | answer |
|---|---|
| Inject a probe without editing the script? | Yes: `/include file` keeps `A_ScriptFullPath`. **Only one `/include` is honoured** (two -> exit 2, silent); the harness merges into `prelude.ahk`. |
| Can a script override built-ins (`SetTimer`)? | Yes, but the original becomes unreachable -> timers/OnMessage are found statically and called by name via `call`. |
| Can `Gui.Prototype.AddButton`, `Gui.Control.Prototype.OnEvent` be wrapped? | Yes (`Add` alone does not see `AddButton`; each `Add*` is wrapped). |
| Fire hotkeys without keyboard input? | Yes: post `WM_HOTKEY` (0x312, wParam = index in definition order) to AHK's hidden main window; works for plain, `$` hook and `~` hotkeys. `ListHotkeys` gives the order. |
| UIA on the hidden desktop? | Inspection and `setvalue` work (managed UIA on a thread attached to the desktop). `Invoke`/`Toggle` on plain Win32 buttons throw -> use `press`/`check`. |
| Screenshots on the hidden desktop? | `PrintWindow(PW_RENDERFULLCONTENT)` works, even for hung windows; the ladder falls back to `PrintWindow(0)`, window DC, screen BitBlt; desktop shots are composited window by window. |
| Hang detection? | A plain AHK `Loop` still pumps messages; block in a `DllCall("Sleep")` to test. Detected via `SendMessageTimeout(ABORTIFHUNG)`, reported after 4s. |
| Does the job's clipboard limit protect the clipboard? | **No**: it blocks `SetClipboardData` but `EmptyClipboard` succeeds and wipes the user's clipboard (caught by selftest). Fixed by the clipboard guardian (snapshot + restore on `WM_CLIPBOARDUPDATE` when the owner is one of our pids). |
| Private window station for full isolation? | `CreateWindowStation` with a name -> access denied; with a NULL name it works (`Service-0x0-...$`). But windows in a non-interactive station are never visible (`WSF_VISIBLE` cannot be set): AHK GUIs exit and `MsgBox` never shows. Kept as `--station` (opt-in), useless for GUI targets. |
| Desktop enumeration | `EnumDesktops` needs a Unicode delegate (`CharSet.Unicode`) or names arrive truncated to one character. |

## Design decisions
- **Message-based input, never `SendInput`.** SendInput targets the input desktop (yours); messages target an HWND on the hidden one. Buttons are pressed with a *posted* `BM_CLICK` so a click that opens a modal dialog cannot block the harness.
- **Evidence first.** Every event is appended to `events.jsonl` (monotonic ms + wall clock). Per-item files, never a monolithic JSON cache (the AST harness' 204 MB cache lesson). Retention via `keepRuns`.
- **Ground truth ordering:** AutoHotkey `/Validate` > language server > AST parser (experimental). `lint` shows disagreements.
- **Originals are never modified.** Shadow copy under the run folder (bounded: 6000 files / 250 MB), patches applied with a code-aware mask (strings, comments and continuation sections are not code), out-of-tree `#Include`s made absolute, patched files + diff + line map archived as `effective/`.
- **Smoke safety:** shadow copy, `stub-dangerous` recipe, label deny-list, `press: safe` for dialogs, keep-going so one error doesn't hide the next, budgeted and seeded (same seed = same order).
- **The reducer locks onto the original finding's signature** (paths/numbers normalised); otherwise ddmin happily reduces to a *different* bug.

## Not done / known limits
- Registry and network are not virtualised (only files via the shadow copy, plus the destructive-call stubs).
- There is no way to synthesise real key events on the hidden desktop (use `hotkey.fire`).
- UIA-only controls (WebView2 content, custom-drawn) are inspectable but not always drivable without real input.
- The AST parser is experimental; its errors are informational.
- `responsive` in `windows` is a 150 ms probe; the authoritative hang signal is the `hung` event (4 s).
