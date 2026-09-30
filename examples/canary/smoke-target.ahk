#Requires AutoHotkey v2.0
#SingleInstance Off
; Smoke-test target: a small "real" app with deliberate bugs for the automatic smoke tester to find.
;   - "Divide" button: divides by the number typed in the edit (crashes with an error for 0 / text)
;   - "Delete Everything" button: dangerous label (the tester must NOT press it)
;   - Tab control, list, checkbox, combo, menu, hotkeys, a timer, and a dialog that asks a destructive question
global count := 0
g := Gui("+Resize", "Smoke Target")
g.MarginX := 12, g.MarginY := 10
g.AddText("w400", "Number:")
num := g.AddEdit("vnum w200", "10")
g.AddButton("w100 Default", "Divide").OnEvent("Click", Divide)
g.AddButton("x+8 w140", "Delete Everything").OnEvent("Click", DeleteAll)
cb := g.AddCheckbox("xm vverbose", "Verbose")
cb.OnEvent("Click", (c, *) => FileAppend("verbose=" c.Value "`n", "*", "UTF-8"))
lb := g.AddListBox("xm w200 r4 vpick", ["one", "two", "three", "four"])
lb.OnEvent("Change", PickChanged)
dd := g.AddDropDownList("x+8 w150 vmode Choose1", ["fast", "slow", "broken"])
dd.OnEvent("Change", ModeChanged)
tabs := g.AddTab3("xm w400 h90 vtabs", ["General", "Advanced"])
tabs.UseTab(1)
g.AddText(, "General page")
tabs.UseTab(2)
g.AddButton("w120", "Advanced Action").OnEvent("Click", (*) => FileAppend("advanced-action`n", "*", "UTF-8"))
tabs.UseTab()
mb := MenuBar()
fm := Menu()
fm.Add("&About", (*) => MsgBox("Smoke Target v1", "About"))
fm.Add("&Crash Menu", CrashMenu)
mb.Add("&File", fm)
g.MenuBar := mb
g.OnEvent("Close", (*) => ExitApp())
g.Show("w430")
SetTimer(Tick, 700)
FileAppend("smoke-target-ready`n", "*", "UTF-8")

Tick() {
    global count
    count++
    if (count = 4)
        FileAppend("tick4`n", "*", "UTF-8")
}
Divide(*) {
    v := num.Value
    FileAppend("divide by " v "`n", "*", "UTF-8")
    r := 100 / v
    MsgBox("100 / " v " = " r, "Result")
}
DeleteAll(*) {
    FileAppend("DANGEROUS-BUTTON-PRESSED`n", "*", "UTF-8")
    MsgBox("Everything deleted!", "Oops")
}
PickChanged(*) {
    FileAppend("picked " lb.Text "`n", "*", "UTF-8")
}
ModeChanged(c, *) {
    FileAppend("mode " c.Text "`n", "*", "UTF-8")
    if (c.Text = "broken")
        throw Error("mode 'broken' is not supported", -1, c.Text)
}
F9::FileAppend("F9-pressed`n", "*", "UTF-8")
F10:: {
    r := MsgBox("Really erase all data?", "Confirm", "YesNo Icon!")
    FileAppend("confirm result=" r "`n", "*", "UTF-8")
}
F11:: {
    notCallable := 0
    notCallable()
}

CrashMenu(*) {
    throw Error("menu crash", -1, "from menu")
}
