# ahkh — AutoHotkey v2 test harness

Run, probe, lint, smoke-test and instrument AutoHotkey v2 scripts (and any Windows GUI app) **without ever putting a window on your screen, stealing focus, or touching your mouse**. Built to be driven by AI agents (CLI, MCP server) and humans alike.

```
ahkh run app.ahk --for 5            # run on a hidden desktop, catch every dialog/error/crash, screenshot, verdict
ahkh smoke app.ahk                  # discover controls/menus/hotkeys/timers, poke them all, report bugs
ahkh lint src\                      # AutoHotkey /Validate (ground truth) vs the language server
ahkh session.start app.ahk --probe  # keep it open and drive it: tree, shot, marks, press, type, wait …
ahkh selftest                       # prove the harness itself stays invisible
```

## Install
Needs Windows 10/11, AutoHotkey v2, and **node ≥ 18 or bun** (no npm packages). The native host builds with the .NET Framework 4 `csc.exe` that ships with Windows.
```powershell
powershell -File build.ps1           # native\*.cs -> bin\ahkh-host.exe (C# 5, no SDK needed)
node bin\ahkh.mjs doctor             # or: bun bin\ahkh.mjs doctor    (ahkh.cmd picks bun, else node)
node bin\ahkh.mjs selftest           # 17 checks, ~45s
```
Put the repo folder on `PATH` to use `ahkh` anywhere. The optional language-server features use the VS Code extension `thqby.vscode-autohotkey2-lsp` (found automatically).

**MCP (Claude Code / any MCP client):** `claude mcp add ahkh -- node C:\projects\ahk\AHKTestHarness\bin\ahkh.mjs mcp` — every verb becomes a tool (`ahkh_run`, `ahkh_smoke`, `ahkh_session_start`, `ahkh_shot` …); screenshots come back as images.

## Claude Code skills
`.claude/skills/` holds six skills (loaded automatically when Claude Code runs in this repo): `ahkh` (safe execution + rules), `ahkh-gui-session`, `ahkh-smoke-test`, `ahkh-lint`, `ahkh-modify-instrument`, `ahkh-develop`. To make them available in **every** project, copy them to your user folder:
```powershell
Copy-Item -Recurse -Force C:\projects\ahk\AHKTestHarness\.claude\skills\* $env:USERPROFILE\.claude\skills\
```

## What it does
| | |
|---|---|
| **Invisible** | Targets run on a private desktop inside a kill-on-close Job Object. A guard watches your real session (foreground window, stray windows) and fails the run if anything leaks. The clipboard guardian restores your clipboard if a script empties it. |
| **Catches everything** | Rule engine for dialogs (AHK errors/warnings, `MsgBox`, `InputBox`, file dialogs) classified by structure, not language; hangs, crashes (decoded NTSTATUS), timeouts, exit codes, stdout/stderr, structured runtime errors. |
| **Sees** | Screenshots of desktop/window/control/closeup/scaled, bursts + contact sheets, numbered "set-of-marks" annotation, image diff, pixel probes, Win32 control tree, UI Automation tree, hit-testing. |
| **Drives** | Message-based click/press/type/text/key/select/check/window ops (no `SendInput`), UIA `setvalue`, `WM_HOTKEY` hotkey firing, in-script `fire`/`call`/`var` via the probe. |
| **Modifies safely** | Patch recipes on a shadow copy with line maps back to your original; `/include`-injected probe; stubs for destructive calls; fast-sleep; `#Warn` to stdout. |
| **Lints** | Language-server diagnostics headless (text/json/sarif/junit/github, baselines), 3-way check vs AHK `/Validate`, symbols/definition/references/hover/completion/format/rename, include graph, AST outline/parse/flows/tracing. |
| **Smoke tests** | Automatic surface discovery, seeded fuzz + click-through with a dangerous-label deny-list and dialog "safe" answers, state graph, coverage, leak trend, replayable action log, ddmin reduction of scripts and click paths. |
| **Iterates** | `repeat` (flake rate), `matrix` (32/64-bit × env × args), `bench`, `trace`, profiles, run folders with timestamps everywhere. |

## Layout
```
bin/ahkh.mjs, ahkh.cmd     entry points (node or bun)
native/*.cs                C# host: hidden desktop, jobs, dialogs, capture, input, UIA, guard, images   (csc, .NET 4)
lib/                       JS: verbs (CLI = MCP tools = hub RPC), session, overlay/patch engine, LSP client, smoke tester, MCP, hub
ahk/AhkProbe.ahk           in-process probe (assertions, error chaining, GUI/menu recorder, RPC, bench)
rules/ patches/ profiles/ templates/   dialog rules, patch recipes, workflows, `ahkh init` templates
vendor/ast/                AHK2 AST engine (AstHost.exe + flows), vendored from the AHK2 AST project
examples/canary/           canary scripts used by selftest (MsgBox, errors, hang, GUI, hotkeys, focus/clipboard thief, smoke target)
tests/unit.test.mjs        pure-logic unit tests (node --test / bun test)
docs/                      ARCHITECTURE.md (design + findings), COOKBOOK.md
```

## Configuration — `ahkh.json`
Found by walking up from the current folder (`ahkh init` scaffolds one). Keys: `outDir`, `keepRuns`, `timeoutMs`, `ahk.exe`, `shots{onDialog,onWindow,everyMs,maxEdge,technique}`, `rules[]`, `keepGoing`, `failOnDialog`, `lsp{extension,node,settings}`, `ast.host`, `profiles{}`. Environment: `AHKH_AHK`, `AHKH_LSP`, `AHKH_RUNTIME=node|bun`.

## Safety model, honestly
Desktop isolation stops windows, focus, keyboard/mouse input and hooks from reaching you. A private *window station* would also isolate the clipboard, but Windows never makes windows visible in one (AHK GUIs would simply exit), so it is opt-in (`--station`) and not useful for GUI targets. Instead a **clipboard guardian** snapshots the real clipboard and restores it if a sandboxed process empties it (the job UI limit blocks *writes* but not *EmptyClipboard*). Other shared-session resources that a script can still reach: files, registry, network — the smoke tester runs on a shadow copy with destructive calls stubbed by default; nothing else is virtualised.

See `AGENTS.md` for the agent playbook, `docs/ARCHITECTURE.md` for internals, `docs/COOKBOOK.md` for recipes.
