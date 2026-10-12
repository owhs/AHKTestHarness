#Requires AutoHotkey v2.0
; Canary: console programs started by a script on the hidden desktop. On Windows 11 a new console is handed to the default
; terminal (Windows Terminal), which would open an EMPTY window on the user's real desktop. The host must block that
; (native/Host.Console.cs): nothing may appear, the guard stays clean, each attempt is a console-blocked warning.
; Only ever run this through the harness.
r1 := RunWait('powershell.exe -NoProfile -Command "exit 7"')
r2 := RunWait(A_ComSpec ' /c exit 5')
pid := 0
try Run(A_ComSpec ' /k echo still here', , , &pid)
Sleep(400)
FileAppend("console-children ps=" r1 " cmd=" r2 " run=" (pid ? "started" : "failed") "`n", "*", "UTF-8")
