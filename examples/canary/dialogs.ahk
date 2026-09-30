#Requires AutoHotkey v2.0
; Canary: InputBox and FileSelect.
FileAppend("start`n", "*", "UTF-8")
ib := InputBox("Enter a value", "Canary Input", "w300 h140")
FileAppend("inputbox result=" ib.Result "`n", "*", "UTF-8")
f := FileSelect(1, , "Canary FileSelect")
FileAppend("fileselect result=[" f "]`n", "*", "UTF-8")
ExitApp 0
