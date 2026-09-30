# AHK Test Harness — Killer Wishlist & Design Sketch

> **Status (2026-09-20): built.** This was the pre-build wishlist; see `README.md`, `AGENTS.md` and `docs/ARCHITECTURE.md` for what exists.
> Every P0 and nearly every P1 item shipped. Spikes are resolved in `docs/ARCHITECTURE.md` (findings table). Deliberate deviations:
> - **Window-station isolation** (A8) was built and abandoned: a private station isolates the clipboard perfectly but never shows windows, so GUI targets can't run in it (kept as opt-in `--station`). The clipboard is protected by a **clipboard guardian** instead (snapshot + instant restore), because the selftest showed the job UI limit does not stop `EmptyClipboard`.
> - Only ONE `/include` is honoured by AutoHotkey, so injections are merged into one prelude file.
> - Timers/`OnMessage` cannot be recorded at runtime (overriding a built-in makes the original unreachable): discovered statically and called by name.
> - Not built (P2): OCR, GIF/MP4 of a run, mutation testing, per-PID network ledger, registry ledger, DPI matrix, AHK-version matrix beyond the installed 32/64-bit exes.
>
> Original text follows.

Status (original): **wishlist / pre-build**. Items marked `[SPIKE]` were unverified assumptions to prove *inside the sandbox* before relying on them (never on the real desktop).

Working name: `ahkh` (placeholder).

---

## 0. North star & non-negotiables

1. **Invisible.** Every target runs on a hidden Win32 desktop inside a kill-on-close Job Object. No focus theft, no popups, no cursor movement, no clipboard clobbering, no tray icons on the user's screen.
2. **Proves its own invisibility.** A focus/cursor/clipboard/foreground *guard* samples the real desktop during every run and turns any violation into a FAIL (`FOCUS-STOLEN`, `LEAK`). A `selftest` with canary scripts (MsgBox, WinActivate, Clipboard writes, `Run`) runs first and is cached.
3. **Nothing escapes the evidence.** Every dialog, error, trace, exit code, stdout/stderr/OutputDebug line, window, and screenshot is timestamped and written to a run folder.
4. **AI-first ergonomics.** Terse verdict at the top of every output, compact JSON on demand, artifact *paths* rather than blobs, image size caps (token economy), stable IDs for windows/controls so an agent can say "click e7".
5. **Generic core, thin adapters.** The core knows *processes, desktops, windows, evidence, verdicts*. AHK-ness (validate, `#Warn`, dialog signatures, probe lib) is an adapter. The same core can drive a C# WinForms app, a CLI, or a compiled exe.
6. **Originals are never modified.** All rewriting happens on a shadow copy ("overlay") with the effective script and line-map saved to the run.
7. **C# 5 / csc.exe / .NET 4.0** for the controller. No NuGet. Extensions can be AHK, PowerShell, node, or any exe speaking JSON-lines.

---

## 1. Architecture (layers)

```
 AI / human
    │  CLI verbs (one-shot)  |  session daemon  |  MCP stdio server (P1)  |  plan.json (batch)
    ▼
 ahkh.exe  (C#, csc)  ── core: run manager, evidence writer, verdict engine, rule engine
    │
    ├─ Sandbox        hidden desktop + job object + watcher thread + leak/focus guard
    ├─ Desktop agent  enumerate / capture / inject / UIA on that desktop (in-thread or helper exe) [SPIKE]
    ├─ Modules        lsp · lint · ast · smoke · bench · visual · patch · reduce · matrix
    └─ Adapters       ahk2 (validate, /ErrorStdOut, #Warn→stdout, dialog signatures) · exe · cmd
                        │
                        ▼
              target process (AHK script / exe)  ◄── optional in-process AhkProbe.ahk
                                                       (pipe/file-mailbox RPC, wrappers, asserts)
```

**Reuse map**
| Need | Take from |
|---|---|
| Hidden desktop, job object, suspended-launch race fix, watcher, dialog classify/press, PrintWindow+blank check, leak detector, SetErrorMode, LaunchLock, NTSTATUS decode, `/Validate` wrapper, include relocation + Lib junction, safe delete, selftest | `AHK2 AST\harness\src\{Sandbox,Native,Ahk,SelfTest}.cs` |
| Orphan desktop cleanup (`EnumDesktops` `IsoDesk_*`), non-black frame heuristic, `AssocQueryString` for `.ahk`, PE bitness sniff, message-mouse/key injection recipe (`WM_NCHITTEST`, `AttachThreadInput`) | `IsolatedDesktopGateway` (skip its UI, SetCursorPos, direct-view) |
| Parse / outline / SourceEdit / TraceWrapper / EvalAnalysis (optional module) | `AHK2 AST\build\AstHost.exe` (JSON-lines) |
| Step runner, OnError+watchdog, QPC bench, report/CSV | `AxStudio.Probe.ahk`, `_bench_lib.ahk` |
| Working LSP client (framing, queue-until-initialize, URI) | `AxAHK\...\CodeEditor\AxLsp.ahk` |

---

## 2. Wishlist by area

Legend: **P0** must-have for v1 · **P1** strong wish · **P2** moonshot.

### A. Run & contain ("test unimpeded")
- **P0** Hidden desktop `AHKH_<guid>` + kill-on-close job, suspended launch → assign → resume. Per-run timeout, global run budget, memory cap, die-on-unhandled-exception.
- **P0** Only ever kills its *own* job/PIDs. Never by name (the user runs their own AHK scripts).
- **P0** Per-case: args, cwd, env, stdin, timeout, expected exit code, `#Requires`-aware exe pick (v2 64/32, skip v1/_H mismatch).
- **P0** Isolated `TEMP`/`APPDATA`/`LOCALAPPDATA`/cwd per run; FS ledger of what the target created/changed.
- **P0** Orphan janitor: on start, enumerate stale `AHKH_*` desktops / jobs and clean them.
- **P0** Leak detector: visible windows/processes from the job appearing on the *user's* desktop, or new windows created by out-of-job helpers (e.g. COM local-server activation via RPCSS lands on the real desktop) `[SPIKE]`.
- **P1** AHK version matrix (2.0.19 vs latest, 32/64-bit); DPI matrix (100/125/150/200%) `[SPIKE]`; locale matrix.
- **P1** Optional *real window station* mode (`CreateWindowStation`) for true clipboard/atom/cursor isolation; keep desktop-in-WinSta0 as default `[SPIKE]`.
- **P1** Job UI limits (read/write clipboard, system parameters, display settings, exit windows) as in the AST sandbox.
- **P2** Registry-write and network-connect ledger (per-PID) alongside the FS ledger.

### B. Catch everything ("dialog / result.. fail / catch")
- **P0** Dialog classifier: AHK error / warning / critical, MsgBox, InputBox, FileSelect/common dialogs, "not responding" ghost windows, generic `#32770`, unknown windows. **Locale-independent** rules (class + control layout + button ids), not English string prefixes.
- **P0** **Rule engine** (JSON, first-match): `match {class,title,text,buttons,process}` → `action {press:"Continue"|"OK"|<id>|default, type:"text", close, kill, ignore, screenshot:true, verdict:"FAIL"}`. Defaults: AHK error → capture+kill (or Continue if `--continue-on-error` to try to *keep going* and collect more), warning → Continue, MsgBox → default button, unknown → screenshot+log.
- **P0** Before dismissing, *always* capture: full dialog text, every child control (class/text/id/enabled), the `▶ 123:` line marker, a screenshot, and the target's stdout so far.
- **P0** "Press Continue" via `WM_COMMAND`/`BM_CLICK` (not mouse), `DM_GETDEFID` default-button logic (only trust ids that exist), fallback first push button, fallback `WM_CLOSE`.
- **P0** Make failures machine-readable: force `#Warn X, StdOut`, `/ErrorStdOut=UTF-8`, `/Validate`; map line numbers back through injected lines.
- **P0** Crash decoding (`C0000005`, stack overflow, heap corruption…) → "AutoHotkey crashed", not "load error". Loading ≠ running: always support a *run* phase, not just validate.
- **P0** Capture streams: stdout, stderr, `OutputDebugString` (DBWIN buffer, PID-filtered), exit code, uncaught `Error` with `.Stack` (via probe `OnError` that *chains*, not replaces).
- **P1** Hang detector: `SendMessageTimeout` ping per window + CPU-flat + no output ⇒ `HUNG` with a screenshot and thread stacks if possible.
- **P1** Minidump on crash (optional, size-capped).
- **P1** Signature grouping of findings (paths→`<path>`, numbers→`N`) and dedupe across runs.

### C. See it (visuals, "multiple shots, closeups, timestamps")
- **P0** Capture kinds: whole desktop · window · control · arbitrary rect ("closeup", with `--scale`) · client-area vs frame.
- **P0** Fallback ladder with blank detection: `PrintWindow(PW_RENDERFULLCONTENT)` → `PrintWindow(0)` → `BitBlt` from desktop DC → (P2) DWM thumbnail / Graphics Capture. Report *which* technique produced the pixels and warn on suspected-blank (Trident/WebView2/D3D known-hard `[SPIKE]`).
- **P0** Every shot gets `shots/NNN_<ms-since-start>_<label>.png` + an `index.json` row (wall time, monotonic ms, hwnd, title, rect, DPI, technique, hash).
- **P0** Triggered bursts: `--shots every=250ms for=5s` · `on=window-created` · `on=dialog` · `on=error` · `until=stable` (N identical frames) · pre/post around each input step.
- **P1** **Contact sheet / filmstrip:** stitch a burst into one image with timestamps + window titles, so an agent reads one file, not thirty.
- **P1** **Annotated shots ("set-of-marks"):** overlay numbered boxes on controls with their ids/names, drawn on the *saved image only* (never on screen), so the agent can say "click 7".
- **P1** Token-economy defaults: max edge 1024 unless `--full`; optional grayscale/crop-to-changed-region.
- **P1** Image diff vs baseline (per-region masks, tolerance, perceptual), saved as diff PNG; pixel probes (`pixel x,y`, `wait-for-pixel`, dominant colour in rect).
- **P2** OCR of a region (Tesseract optional / WinRT OCR) so assertions can read custom-drawn text.
- **P2** GIF/MP4 of a run from the frame log.

### D. Inspect ("positions, uia")
- **P0** Window list: hwnd, class, title, pid, owner/parent, rect (DPI-aware), styles/exstyles, visible/enabled/topmost/z-order, min/max state.
- **P0** Child-control tree via Win32 (`EnumChildWindows`, `WM_GETTEXT`, control id, class-specific queries: edit text, checkbox state, combo/list items, tab items, listview rows/cols, treeview nodes).
- **P1** UIA tree (name, automationId, controlType, patterns, bounding rect, value/toggle/expand state) `[SPIKE: UIA cross-desktop → likely needs a helper process launched *on* the desktop]`.
- **P0** Stable element ids (`w1`, `w1.e7`) valid within a session; **selector language**: `window[title~=/Error/] > button[text=OK]`, `#Edit3`, `class=Button && text=~/Save/`.
- **P0** `hit x,y` → what is under this point (control chain).
- **P1** Structural snapshot + **diff** of the window/control tree between two moments ("what changed after I clicked?").
- **P1** Layout lint: zero-size controls, controls outside parent, overlaps, clipped/ellipsised text, off-screen windows, tab order gaps, missing accessible names, min-size violations, DPI scaling anomalies.
- **P1** AHK-aware view via probe: `Gui` objects, control `.Name/.Type/.Value/.Text`, registered `OnEvent` callbacks, menus, hotkeys, timers.

### E. Drive ("press continue, click, type")
- **P0** Message-based input (safe on hidden desktop): `BM_CLICK`, `WM_COMMAND`, `WM_SETTEXT`, `WM_KEYDOWN/CHAR`, `WM_LBUTTON*` with correct client coords, `CB_SETCURSEL`, `TCM_SETCURSEL`, list/tree selection messages, `WM_SYSCOMMAND` (close/min/max), resize/move.
- **P1** UIA patterns: Invoke, Value, Toggle, ExpandCollapse, Selection, ScrollItem.
- **P0** In-process driving via probe: `ControlClick`/`ControlSend`/`ControlSetText` from *inside* the target's own desktop and thread, plus "fire the registered handler" (see K).
- **P0** Waits everywhere (no fixed sleeps): `wait window`, `wait control`, `wait text`, `wait idle` (message queue idle + CPU flat + no window changes for N ms), `wait pixel`, `wait output /regex/`, `wait exit`. All with timeout + on-timeout evidence.
- **P1** Keystroke/hotkey testing where `SendInput` cannot reach the hidden desktop: strategies (a) probe-side callable rewrite of `F1::{...}` bodies, (b) attended opt-in real-input mode on a *scratch* desktop, (c) internal message injection (fragile) `[SPIKE]`. Static hotkey list from AST/`ListHotkeys`.
- **P1** Record & replay: every action gets logged to `actions.jsonl`; `replay` re-executes deterministically.

### F. Modify ("temporarily modifying scripts")
- **P0** **Overlay workspace:** shadow copy of the script tree (hardlink/junction for unchanged files, patched copies for changed ones); originals untouched; effective sources + `linemap.json` saved per run so error lines map back.
- **P0** Patch ops (declarative, stackable, named recipes): text/regex replace · insert before/after line/symbol · include injection · force `#Warn`→stdout · prepend `OnError` · `#SingleInstance Off`/`Force` · stub calls (`MsgBox`/`InputBox`/`FileSelect`/`Sleep`/`ExitApp`/`Run`/`FileDelete`/`RegWrite` → recorded no-ops) · relocate includes to absolute (the AST harness `Prepare` logic).
- **P1** AST-based edits via `AstHost edit` (byte-preserving, returns `newProblems`), and instrumentation via the **TraceWrapper** (function/GUI-event/hotkey tracing → `trace.json`); ask for `Save()` on demand so a killed process still leaves a trace.
- **P1** **Fault injection:** throw at the Nth call of X, return unset from Y, slow down Z (time dilation: scale `Sleep`/`SetTimer` periods), seeded `Random`.
- **P2** **Mutation testing:** AST mutants (flip `&&`, drop a call…) to verify that your checks actually catch regressions.
- **P0** Probe injection preferably via AHK's `/include` switch (keeps `A_ScriptFullPath`/`A_ScriptDir` intact) `[SPIKE: confirm v2 supports /include]`; else a shim wrapper script.

### G. LSP / lint / validation / following
Recipe (verified by reading `server.js` and `AxLsp.ahk`): `node <ext>\server\dist\server.js --stdio`, run from inside the extension folder; `initialize` with **live `processId`**, `rootUri`, and `initializationOptions` = flattened settings (`InterpreterPath`, `locale`, `ActionWhenV1IsDetected:"Continue"`, `Warn{VarUnset,Unused,LocalSameAsGlobal,CallWithoutParentheses}`, `Diagnostics.InvokeCheck`, `AutoLibInclude`, `Files.MaxDepth`, `FormatOptions`); **do not** advertise `workspace.configuration`; reply `null` to `window/showMessageRequest`. URIs are `file:///c%3A/...` (fully percent-encoded). Semantic diagnostics are **lazy**: send `documentSymbol` (or custom `diagnoseAll`) after `didOpen`/`didChange`; debounce 500 ms; clean files publish nothing; force refresh with `didClose`→`didOpen`. Wrong interpreter path adds ~6 s. Startup ~1–2 s ⇒ keep a **warm daemon**.

- **P0** `lsp check <files|dir|glob>` → normalized findings `{file, line, col, endLine, endCol, severity, code, message, sourceLine, fixData}`; handles the lazy pass, republish quirks, and "quiet ≠ clean" ambiguity.
- **P0** Three-way agreement report: **AHK `/Validate`** (ground truth) vs **LSP** vs **AST parser** — surfaces LSP false positives/negatives and AST-parser bugs for free (feeds the AST project).
- **P0** Output formats: `text` (terse), `json`, `sarif`, `junit`, `github-annotations`. Baseline/suppression file + "new since baseline" mode. Exit codes for CI.
- **P1** `lsp symbols|workspace-symbols|def|refs|hover|signature|complete|rename --dry-run|format --check/--diff|semantic-tokens|inlay|extractSymbols|includes`.
- **P1** **Follow:** include graph (resolved/unresolved/optional), call graph, "who calls X", dead code, cross-file go-to-definition chains printed as `file:line  text`.
- **P1** Extra lint via AST `EvalAnalysis` and user rule packs (regex/AST queries, e.g. "`SetTimer` without a matching off", "`OnMessage` without unregister").
- **P1** Apply fixes: LSP `codeAction`/AutoFix as a patch on the overlay, then re-check ("fix loop").
- **P2** Version guard: warn on `3.0.9` vs `3.0.10` sorting (AxLsp bug), auto-locate newest extension.

### H. Scripting for AI loops ("loops / iteration")
- **P0** Three interfaces to the same engine: **(1)** one-shot verbs; **(2)** **session**: `ahkh session start` → id, then `ahkh -s <id> shot | tree | click e7 | type e3 "hi" | wait …` with a persistent desktop+process, so an agent explores step by step with short calls; **(3)** batch `ahkh run plan.json` / an `.ahkt` AHK test file using the probe API.
- **P1** **MCP stdio server** (`ahkh mcp`) exposing the session verbs as tools with images returned natively.
- **P0** Iteration primitives: `--repeat N` (flake rate), `--until <cond>`, `--budget <sec>`, stop-on-first-fail, watch mode (rerun on file change), result cache keyed by content+tool hashes (per-item files — never a 200 MB monolith), "newly failing / newly fixed" delta versus last run.
- **P1** **Reducer:** ddmin for *scripts* (still triggers same signature) **and for action sequences** (minimal click path to a bug) → saves a self-contained repro case.
- **P1** `bisect` (git good/bad + command), parameter sweeps (matrix: version × DPI × window size × locale).
- **P1** Case files: header annotations (`; @run`, `; @expect /re/`, `; @timeout`, `; @args`, `; @flows`), golden transcripts (LCS diff), assertion helpers with regex, exit-code, window/control, timing, and screenshot assertions.

### I. Logging & evidence ("logging to a folder")
```
runs/<yyyyMMdd-HHmmss>-<label>/
  result.json        verdict, counts, findings[], env (versions, hashes, git rev, exe paths)
  summary.md         terse; verdict + top findings + suggested next command first
  events.jsonl       everything, wall + monotonic ms: launch, window, dialog, input, output, shot, verdict
  stdout.txt stderr.txt debug.txt
  shots/  NNN_<ms>_<label>.png  + index.json
  dialogs/ NNN.json (+ png)
  trees/   NNN.json  (window/control/UIA snapshots)
  effective/ patched sources + linemap.json
  trace.json  actions.jsonl  junit.xml  sarif.json (optional)
runs/latest.txt      (pointer file, not a symlink)
```
- **P0** Verdict taxonomy with exit codes: `PASS FAIL ERROR TIMEOUT CRASH HUNG LEAK FOCUS-STOLEN DIALOG SKIPPED`.
- **P0** Retention/pruning policy (the AST harness has 161 unpruned run dirs) and JSONL over monolithic JSON.
- **P1** Redaction (usernames/paths) option for sharing bundles; `pack` → zip of a run for bug reports.
- **P1** Trend/flake tracking across runs (SQLite-free: append-only JSONL index).

### J. Perf & health
- **P1** QPC timers, marks, enter/leave inclusive/self time, method wrapping, µs/op micro-bench with baseline, median-of-N + variance, thresholds vs baseline (from `_bench_lib`).
- **P1** Startup metrics: time-to-first-window, time-to-idle, CPU/working-set/handle/GDI/USER object counts over time ⇒ **leak trend** during smoke runs.

### K. In-process probe library `AhkProbe.ahk`
- **P0** One-line opt-in (`#Include`) or injected by the overlay; RPC to the controller via named pipe or file mailbox with request ids; never blocks the target's pump; `Critical`-safe.
- **P0** Assertions (`Assert/Expect` with expected/actual), `WaitFor`, `Step`, `Shot(label)`, `Log`, `Mark`, chained `OnError` (records `Error.Stack`, `A_LastError`), watchdog exit with a *non-zero* exit code on failure (the AxStudio probe always exits 0 — a known gap).
- **P0** **Registration recorder:** wrap `Gui.Prototype.Add`, `Gui.Control.Prototype.OnEvent`, `Menu.Prototype.Add`, `Gui.OnEvent`, etc. via `DefineProp`, so the *actual* set of handlers/controls/menus is known at runtime. Global built-ins (`SetTimer`, `OnMessage`, `Hotkey`, `OnExit`, `OnClipboardChange`) need override or AST rewrite `[SPIKE: can a script shadow built-in functions in v2?]`.
- **P0** `Probe.Call(name, args*)`, `Probe.Get(name)`, safe object `Dump` with depth/size limits, `Probe.Fire(ctrl, "Click")` invoking the recorded handler, `Probe.Snapshot()` (Gui tree, hotkey list via `ListHotkeys`, timers).
- **P1** Non-focus-stealing defaults (`NoActivate`, `Show("NA")`, HWND_BOTTOM) even when run on a normal desktop as a fallback mode.

### L. Automatic smoke tester ("some kinda automatic smoke tester")
Goal: point it at an unknown script → get a surface map, a pass/fail, screenshots, and a minimal repro for anything that breaks. Ascending levels, each gate-able:

| Level | What | Tools |
|---|---|---|
| S0 | Static: `/Validate`, LSP diagnostics, AST parse, include resolution, dangerous-API scan (Run/FileDelete/RegDelete/Shutdown/…) | validate, lsp, ast |
| S1 | Boot: launch on hidden desktop, survive T seconds, no error/crash/leak/hang, list windows, first-paint shot | sandbox |
| S2 | **Discover surfaces**: static (AST outline: functions/params, hotkeys, hotstrings, `SetTimer`/`OnMessage`/`OnEvent` calls, GUI controls, menus) **+** dynamic (probe registration recorder, Win32/UIA tree, tray/context menus) → `surface.json` | ast, probe, inspect |
| S3 | **Poke**: click every button/menu/tray item; toggle checks; select every list/combo/tab item; type fuzz strings (empty, huge, unicode, quotes, `%`, paths, newlines) into every edit; open→Esc every dialog; resize/min/max/restore; fire each timer/hotkey/`OnMessage`/GUI-event callback; (opt-in) call public functions with type-fuzzed args | drive, probe |
| S4 | **Observe each poke**: new windows/dialogs? error? stdout? CPU spike/hang? memory/handle growth? tree diff? screenshot diff? → findings with a shot and the action that caused them | evidence |
| S5 | **GUI ripping:** BFS/DFS over states (state = window set + control-tree hash), seeded + budgeted, produce a **state-transition graph**; report *coverage* (controls poked / handlers fired / lines traced if TraceWrapper on) | smoke, ast trace |
| S6 | Every failing action sequence auto-**reduced** to a minimal repro and saved as a replayable case | reducer |

Safety rails: deny-list by button text (`Delete|Format|Uninstall|Send|Reset|Shutdown|Yes to all…`) and by API scan; FS/registry ledger; scratch `TEMP`/`APPDATA`/cwd; `--allow` file for "this is safe to poke"; dry-run recorders for stubbed dangerous calls; network off by default `[SPIKE: per-PID firewall rule / stub]`.

### M. Adaptability ("adaptable to any situation")
- **P0** Project file `ahkh.json`: target, adapter, exe paths, roots, profiles, rules, patches, oracles, output dir, retention.
- **P0** **Modules are processes**: anything that speaks JSON-lines on stdio (C#, AHK, PowerShell, node). Hooks: `beforeRun`, `onWindow`, `onDialog`, `onOutput`, `onShot`, `afterRun`; custom oracles, dialog rules, classifiers, reporters.
- **P0** Ready-made **profiles**: `lint` (LSP+validate), `smoke`, `gui-probe`, `bench`, `roundtrip` (the AST project), `cli`.
- **P1** `ahkh init <profile>` scaffolder; `ahkh doctor` (finds AHK, node, LSP extension, csc; prints what's missing).
- **P1** Non-AHK targets: any exe (WinForms/WPF/Electron), with the same hidden-desktop/inspect/drive/evidence stack.
- **P2** Cross-platform-ish core split (only the sandbox/desktop agent is Win32-bound).

---

## 3. Phasing (proposed)

| M | Deliverable | Exit test |
|---|---|---|
| **M0** | Repo skeleton, `build.ps1` (csc), `doctor`, sandbox lifted+generalised, `selftest` with canaries (MsgBox/WinActivate/clipboard/`Run`), run folder + verdicts | canary scripts contained; foreground/cursor/clipboard unchanged |
| **M1** | Dialog rule engine, output/OutputDebug capture, crash decode, `validate`/`run` verbs, AHK adapter (`#Warn`→stdout, linemap) | AHK error/warn/MsgBox dialogs all caught, screenshotted, dismissed by rules |
| **M2** | Visuals + inspect + message-based drive + waits + selectors; contact sheet; session daemon | agent can open a GUI, list controls, click, screenshot closeups end-to-end |
| **M3** | Overlay/patch engine + `AhkProbe.ahk` (asserts, wrappers, chained OnError, /include injection) | patched run leaves originals untouched; probe RPC round-trip |
| **M4** | LSP module + three-way agreement + formats + daemon warm-start | `lsp check` over a folder equals VS Code's problems panel |
| **M5** | Smoke tester S0–S4, then S5–S6 (ripping, reducer) | unknown sample GUI script → surface map + findings, no popups |
| **M6** | Bench, matrix, MCP server, AstHost/TraceWrapper integration, mutation testing | — |

---

## 4. Spikes to run first (inside the sandbox — never on the real desktop)

1. UIA against a target on a non-input desktop: helper exe launched with `lpDesktop`, or in-thread after `SetThreadDesktop`?
2. `PrintWindow` on Trident/WebView2/D3D content on the hidden desktop; which fallback wins.
3. Message-only input sufficiency: AHK `Gui` buttons, custom-drawn controls, edits with `WM_CHAR`, hover/mouse-capture.
4. Does AHK v2 accept `/include "file"` (probe injection without changing `A_ScriptFullPath`)?
5. Can a v2 script shadow a built-in (`SetTimer`, `OnMessage`, `Hotkey`) with its own function? If not, AST rewrite is the recorder.
6. Hotkey firing without `SendInput` (callable rewrite vs internal message).
7. What escapes the desktop: COM local-server activation, `Run` of shell verbs, single-instance handoff, tray icons.
8. Full window-station isolation vs desktop-only (clipboard, atoms, cursor).
9. Headless LSP: confirm the lazy-diagnostics and republish behaviour on real files; measure warm vs cold.
10. Loading `AstEngine.dll` in-process vs using `AstHost.exe` over stdio (prefer the latter).

## 5. Known hazards to design around (from the sibling projects)
- `/Validate` only *loads*; runtime bugs need a run phase.
- AHK 2.0.19 can *crash* (exit `0xC0000005`) instead of erroring on some malformed inputs — treat as crash, not load error.
- Dialog classification by English text is brittle; use structure.
- Handles must not leak across concurrent child launches (`LaunchLock`).
- Never recurse-delete through junctions.
- Fixed sleeps are races; poll for conditions.
- `PrintWindow` on a frame HWND can return blank; target the right child/window and check for blank.
- Wall-clock perf numbers are noise on a busy machine; use CPU time, medians, A/B interleaving.
- A pipe read can block forever; use files/overlapped IO + timeouts.
- `!` in paths breaks `cmd` delayed expansion; quote via `CreateProcess`, not `cmd /c`.
- Git Bash rewrites `/Switch` args (`/Validate` → `C:/Program Files/Git/Validate`); launch from PowerShell or with `MSYS_NO_PATHCONV=1`.
- The AST parser is experimental: prefer `/Validate` + LSP as ground truth.
