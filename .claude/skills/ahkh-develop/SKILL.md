---
name: ahkh-develop
description: Work on the ahkh harness itself (C:\projects\ahk\AHKTestHarness) - add verbs, dialog rules, patch recipes, profiles, native C# host features or probe commands; rebuild, run selftest and unit tests, avoid the known editing and Windows pitfalls. Use when changing files under native/, lib/, ahk/, rules/, patches/, profiles/ or tests/ of this repo.
---

# Developing the harness

Read `README.md` and `docs/ARCHITECTURE.md` (protocols + spike findings table) first.

## Loop
```
powershell -File build.ps1            # native\*.cs -> bin\ahkh-host.exe (skips if unchanged; -Force to rebuild). C# 5 ONLY: no $"", ?., =>-members, nameof, out var
node --test tests/unit.test.mjs       # 21 pure-logic tests, also: bun test tests/unit.test.mjs
node bin\ahkh.mjs selftest            # 17 sandbox checks (~45s) - must stay green; --quick skips the slow ones
node bin\ahkh.mjs smoke examples\canary\smoke-target.ahk    # end-to-end regression of the smoke tester
```
Run under both `node` and `bun` for anything touching sockets, child processes or the hub (`AHKH_RUNTIME=bun ahkh.cmd ...`). JS has **no npm dependencies** - keep it that way.

## Where things go
- **New CLI verb / MCP tool:** `lib/verbs/<file>.mjs` with `defineVerb({name, group, desc, args:{name:{type,positional,required,default,alias,greedy,desc}}, needsHub?, local?, run(ctx,a){ return {verdict|ok, summary, data, images?, exitCode?} }})`, then import it in `lib/verbs/index.mjs`. `needsHub` = session-bound (runs in the hub / MCP process); `local` = never via hub. `summary` is what a human/agent reads: first line `VERDICT label ...`, terse.
- **Native command:** add a `case` in `native/Program.cs` `Rpc.Dispatch`, implement in a `Host.*.cs` partial (window work must go through `OnDesk(...)` - the desk thread is the only one attached to the hidden desktop), rebuild, expose via `Session` in `lib/session.mjs`.
- **Dialog behaviour:** `rules/default.json` (structural `kind` first; add classifications in `Host.Watch.cs` `Classify`). **Patch recipe:** `patches/*.json`. **Workflow:** `profiles/*.json`. **Probe command:** `Ahkh._Handle` in `ahk/AhkProbe.ahk` + a verb in `lib/verbs/probe.mjs`.
- **New spike / finding:** add a row to the findings table in `docs/ARCHITECTURE.md`.

## Hard rules for this repo
1. **Never run AutoHotkey or any GUI target outside the harness** (not even to "quickly test a switch"). Spike inside a session (`Session.open` + `launch`), see the scratch pattern in selftest.
2. **Never kill processes by name**; only `proc.kill`/jobs. The user runs their own AHK scripts.
3. Anything that could touch the user's session (clipboard, foreground, mouse) needs a check in selftest.
4. Keep the evidence-first design: every event to `events.jsonl`, per-item files, no giant JSON caches.

## Pitfalls that already cost time
- **Edit code containing backslashes with the Write/Edit tools**, not bash/python heredocs or `node -e`: escapes get eaten (a `\b` regex became a literal backspace char). After scripted edits: `node --check`, and scan for control chars (`cat -A` shows backspace as `^H`).
- The host request key `id` is the *request* id; process names travel as `proc`.
- `EnumDesktops`-style callbacks with strings need `CharSet.Unicode` on the delegate.
- AutoHotkey honours exactly one `/include`; a second one = silent exit code 2.
- Job UI limits do not stop `EmptyClipboard`; the clipboard guardian (`Host.Clip.cs`) does. Private window stations never show windows (GUI targets can't use `--station`).
- Posting (not sending) `BM_CLICK` - a synchronous click that opens a modal dialog would block the host.
- `Error(msg, -1)` in test scripts gives misleading line numbers; use plain `Error(msg)` in canaries.
- PowerShell splits `a,b,c` into separate arguments (hence `greedy` array args); Git Bash rewrites `/Switch`.

## Adding a canary
Put it in `examples/canary/`, make it print to stdout with `FileAppend(text, "*", "UTF-8")`, and add a `check(...)` in `lib/verbs/selftest.mjs` asserting the verdict, findings and stdout. Canaries that annoy users (focus/clipboard/mouse) must only ever be run through the harness.
