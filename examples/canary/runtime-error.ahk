#Requires AutoHotkey v2.0
; Canary: uncaught runtime error -> AHK error dialog. The harness must catch it, screenshot it, and end the run.
FileAppend("before-error`n", "*", "UTF-8")
Foo() {
    x := "abc"
    return x.NoSuchMethod()
}
Foo()
FileAppend("after-error (only reached with keep-going)`n", "*", "UTF-8")
ExitApp 0
