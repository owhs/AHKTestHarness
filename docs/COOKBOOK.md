# Cookbook

## Catch every dialog of a flaky script, with pictures
```powershell
ahkh run tool.ahk --for 20 --shots-every 500 --shots-on-window
ahkh runs.sheet latest            # one contact-sheet image of everything that appeared
```

## Lint a project in CI (SARIF + baseline)
```powershell
ahkh lsp.check src --format sarif --out lint.sarif --baseline .ahkh/lint-baseline.json
ahkh lsp.check src --baseline .ahkh/lint-baseline.json --update-baseline   # accept the current state once
```

## Make a script deterministic and fast for testing
```powershell
ahkh run slow.ahk --patch fast-sleep --patch stub-dangerous --patch warn-stdout
ahkh patch slow.ahk --patch fast-sleep --diff        # see exactly what changes; the original is untouched
```
Write your own: `patches/my-fix.json` = `{"name":"my-fix","ops":[{"op":"replace","file":"*","regex":"Sleep\\((\\d+)\\)","with":"Sleep(1)"}]}`.

## Drive a settings dialog and check the result
```powershell
ahkh session.start app.ahk --probe
ahkh press "button:Settings" ; ahkh wait window Settings
ahkh marks                                   # numbered controls
ahkh check "class=Button&text~=Dark" --state true
ahkh press "button:OK" ; ahkh var themeName        # read one of the script's own global variables
ahkh session.stop
```

## Assertions inside a script (no external test framework)
```ahk
#Include C:\projects\ahk\AHKTestHarness\ahk\AhkProbe.ahk   ; or simply run with --probe
Ahkh.Step("adds", () => Ahkh.Expect(Add(2, 3), 5, "Add"))
Ahkh.Assert(FileExist("out.txt"), "output written")
Ahkh.Done()                      ; exit code 1 if anything failed
```
`ahkh run t.ahk --probe` turns failures into `assertion` findings with file:line.

## Find and minimise a bug in an unknown GUI
```powershell
ahkh smoke app.ahk --budget 90 --seed 7
ahkh reduce actions app.ahk --actions <run-name> --match "not supported"    # shortest click path
ahkh replay app.ahk --actions reduced-actions-123.jsonl
```

## Compare visual output between two runs
```powershell
ahkh img.diff before.png after.png --out diff.png --max-pct 0.5
```

## Flakes and versions
```powershell
ahkh repeat test.ahk --count 10
ahkh matrix app.ahk --env '[{"LANG":"de"},{"LANG":"ja"}]'      # also runs 32-bit AutoHotkey if installed
ahkh bench app.ahk --runs 7 --csv bench.csv
```

## Trace what a script actually calls
```powershell
ahkh trace app.ahk --for 5 --lines
```

## Add a new capability
1. New verb: `lib/verbs/mine.mjs` with `defineVerb({name, group, desc, args, run(ctx, a){...}})`; import it in `lib/verbs/index.mjs`. It is instantly a CLI verb, an MCP tool and hub-callable.
2. Native feature: add a command in `native/Program.cs` `Rpc.Dispatch`, implement it in a `Host.*.cs`, then `powershell -File build.ps1`.
3. Non-AHK target: `ahkh session.start --exe C:\path\app.exe` - everything except the AHK probe works on any Win32 GUI.
