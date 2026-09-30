#Requires AutoHotkey v2.0
; Reducer demo: only the broken `if` line matters. `ahkh reduce script examples\canary\reduce-me.ahk --match Missing`
counter := 0
Add(a, b) {
    return a + b
}
Greet(name) {
    return "Hello, " name
}
class Thing {
    __New() {
        this.x := 1
    }
}
loop 3 {
    counter += Add(counter, 1)
}
if (counter > 2 {
    counter := 0
}
message := Greet("world")
FileAppend(message "`n", "*", "UTF-8")
t := Thing()
