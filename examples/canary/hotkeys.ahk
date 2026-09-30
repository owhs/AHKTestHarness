#Requires AutoHotkey v2.0
; Canary: hotkeys + a global function + a global variable, for probe/hotkey tests. Runs until stopped.
counter := 0
F13:: {
    global counter
    counter++
    FileAppend("F13 counter=" counter "`n", "*", "UTF-8")
}
F14::FileAppend("F14-fired`n", "*", "UTF-8")
^!F15::FileAppend("CtrlAltF15-fired`n", "*", "UTF-8")
$F16::FileAppend("F16-hook-fired`n", "*", "UTF-8")
~F17::FileAppend("F17-tilde-fired`n", "*", "UTF-8")
Add(a, b) => a + b
Fail() {
    throw Error("deliberate failure", -1, "from Fail()")
}
FileAppend("hotkeys-ready`n", "*", "UTF-8")
