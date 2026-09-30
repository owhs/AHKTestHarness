#Requires AutoHotkey v2.0
; Canary: syntax error at load time.
FileAppend("never printed`n", "*", "UTF-8")
if (1 {
    MsgBox "broken"
}
