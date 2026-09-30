#Requires AutoHotkey v2.0
#SingleInstance Off
; Canary GUI: controls that print to stdout when used. Runs until closed (expects --for).
g := Gui("+Resize", "Canary GUI")
g.SetFont("s10")
g.AddText("w300", "Type something and press the buttons:")
ed := g.AddEdit("vname w300 r1", "")
ed.OnEvent("Change", (c, *) => Out("edit-changed=" c.Value))
cb := g.AddCheckbox("vopt", "Enable option")
cb.OnEvent("Click", (c, *) => Out("checkbox=" c.Value))
dd := g.AddDropDownList("vchoice w200 Choose1", ["Alpha", "Beta", "Gamma"])
dd.OnEvent("Change", (c, *) => Out("choice=" c.Text))
btn := g.AddButton("w120 Default", "Say Hello")
btn.OnEvent("Click", (*) => Out("button-hello name=" ed.Value))
b2 := g.AddButton("x+10 w120", "Open Dialog")
b2.OnEvent("Click", (*) => (Out("opening-dialog"), MsgBox("Dialog opened from button", "Canary Sub-Dialog"), Out("dialog-closed")))
b3 := g.AddButton("x+10 w120", "Boom")
b3.OnEvent("Click", (*) => (Out("boom-clicked"), Boom()))
g.OnEvent("Close", (*) => (Out("gui-closed"), ExitApp()))
g.Show("w460")
Out("gui-ready")
Out(s) => FileAppend(s "`n", "*", "UTF-8")
Boom() {
    throw Error("Boom from button", -1, "canary")
}
