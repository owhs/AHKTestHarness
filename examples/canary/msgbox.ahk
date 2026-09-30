#Requires AutoHotkey v2.0
; Canary: a MsgBox that would block forever on a normal desktop. The harness must catch and dismiss it.
FileAppend("before-msgbox`n", "*", "UTF-8")
r := MsgBox("Hello from the canary MsgBox.`nDo you want to continue?", "Canary MsgBox", "YesNo Icon?")
FileAppend("after-msgbox result=" r "`n", "*", "UTF-8")
ExitApp 0
