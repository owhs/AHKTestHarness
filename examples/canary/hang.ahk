#Requires AutoHotkey v2.0
; Canary: shows a window then blocks the message pump (a blocking API call), so the window stops responding.
; (A plain AHK Loop keeps pumping messages, which is why we block in a DllCall instead.)
g := Gui(, "Canary Hang")
g.AddText(, "About to hang...")
g.Show("w300 h100")
FileAppend("shown`n", "*", "UTF-8")
Sleep 300
DllCall("Sleep", "uint", 25000)
FileAppend("woke`n", "*", "UTF-8")
