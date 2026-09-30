#Requires AutoHotkey v2.0
; Canary: #Warn VarUnset dialog.
#Warn VarUnset, MsgBox
FileAppend("before-warn`n", "*", "UTF-8")
y := notDefinedAnywhere + 1
FileAppend("after-warn`n", "*", "UTF-8")
ExitApp 0
