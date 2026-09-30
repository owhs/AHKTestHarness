#Requires AutoHotkey v2.0
; Containment canary. Everything below would annoy a real user (steal focus, move the mouse, write the clipboard, sit on top).
; On the hidden desktop none of it may reach the user's session. ahkh selftest asserts exactly that.
g := Gui("+AlwaysOnTop", "Canary Focus Thief")
g.AddText(, "I want the foreground!")
g.Show("w300 h100")
loop 5 {
    try WinActivate("ahk_id " g.Hwnd)
    try WinSetAlwaysOnTop(1, "ahk_id " g.Hwnd)
    try MouseMove(5 + A_Index, 5 + A_Index, 0)
    try A_Clipboard := "AHKH-CANARY-CLIPBOARD-" A_Index
    Sleep 120
}
try ToolTip("tooltip from canary", 10, 10)
try TrayTip("canary tray tip", "Canary")
FileAppend("thief-done clip=[" A_Clipboard "]`n", "*", "UTF-8")
Sleep 800
ExitApp
