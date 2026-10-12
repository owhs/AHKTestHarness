#Requires AutoHotkey v2.0
#SingleInstance Off
Persistent
; Canary for composed screenshots: windows whose pixels only DWM has. GDI capture (PrintWindow / BitBlt) shows them black or empty;
; a composed shot must show them as the screen would. Known pixels (screen coordinates, background #000000):
;   (200,250)  plain window client: green 0,128,0
;   (350,250)  per-pixel-alpha UpdateLayeredWindow, red at alpha 128 over the green window -> about 128,64,0
;   (450,250)  same window, opaque blue 0,0,255
;   (700,150)  white window at SetLayeredWindowAttributes alpha 128 over black -> about 128,128,128
;   (700,350)  orange window excluded from capture (WDA_EXCLUDEFROMCAPTURE) -> 255,128,0 (from its redirection surface)
;   (250,600)  WS_EX_NOREDIRECTIONBITMAP window showing a DWM thumbnail of the green window -> green
;   (950,150)  yellow UpdateLayeredWindow window, excluded from capture: unreadable without the probe; with it -> 255,255,0
;   (310,250)  the layered window's alpha-0 strip: green shows through, and a click there reaches the plain window
; The plain window prints "hover x,y cursor X,Y" (client point, MouseGetPos in screen coordinates) and "down x,y".
; Prints "ready" when everything is up. Run only through the harness.
DllCall("SetThreadDpiAwarenessContext", "Ptr", -4, "Ptr")

g1 := Gui("-DPIScale", "composed-plain")
g1.BackColor := "008000"
g1.Show("x100 y100 w400 h300 NoActivate")

g2 := Ulw(300, 200, 200, 100, (x, y) => x < 20 ? 0 : x < 100 ? 0x80800000 : 0xFF0000FF, "composed-ulw")   ; x < 20: alpha 0 = click-through

; the synthetic mouse (`ahkh mouse`): hover and clicks on the plain window, with where the script thinks the cursor is
OnMessage(0x200, Hover), OnMessage(0x201, Down)
Hover(w, l, m, h) {
    static last := ""
    if (h != g1.Hwnd || (s := (l & 0xFFFF) "," (l >> 16)) = last)
        return
    last := s, CoordMode("Mouse", "Screen"), MouseGetPos(&mx, &my)
    FileAppend("hover " s " cursor " mx "," my "`n", "*", "UTF-8")
}
Down(w, l, m, h) {
    if (h = g1.Hwnd)
        FileAppend("down " (l & 0xFFFF) "," (l >> 16) "`n", "*", "UTF-8")
}

g3 := Gui("-Caption +E0x80000 -DPIScale", "composed-lwa")
g3.BackColor := "FFFFFF"
g3.Show("x600 y100 w200 h100 NoActivate")
WinSetTransparent(128, g3)

g4 := Gui("-Caption -DPIScale", "composed-excluded")
g4.BackColor := "FF8000"
g4.Show("x600 y300 w200 h100 NoActivate")
DllCall("SetWindowDisplayAffinity", "Ptr", g4.Hwnd, "UInt", 0x11)

g5 := Gui("-Caption +E0x200000 -DPIScale", "composed-thumb")
g5.Show("x100 y450 w300 h200 NoActivate")
thumb := 0
DllCall("dwmapi\DwmRegisterThumbnail", "Ptr", g5.Hwnd, "Ptr", g1.Hwnd, "Ptr*", &thumb)
props := Buffer(48, 0)
NumPut("UInt", 0x1 | 0x4 | 0x8, props, 0)                     ; RECTDESTINATION | OPACITY | VISIBLE
NumPut("Int", 0, "Int", 0, "Int", 300, "Int", 200, props, 4)  ; rcDestination
NumPut("UChar", 255, props, 36), NumPut("Int", 1, props, 40)  ; opacity, fVisible
DllCall("dwmapi\DwmUpdateThumbnailProperties", "Ptr", thumb, "Ptr", props)

g6 := Ulw(900, 100, 100, 100, (x, y) => 0xFFFFFF00, "composed-ulw-excluded")
DllCall("SetWindowDisplayAffinity", "Ptr", g6.Hwnd, "UInt", 0x11)

FileAppend("ready`n", "*", "UTF-8")

; A per-pixel-alpha layered window: px(x, y) returns premultiplied ARGB.
Ulw(X, Y, W, H, px, title) {
    g := Gui("-Caption +E0x80000 +ToolWindow -DPIScale", title)
    g.Show("x" X " y" Y " w" W " h" H " NoActivate")
    bi := Buffer(40, 0)
    NumPut("UInt", 40, "Int", W, "Int", -H, "UShort", 1, "UShort", 32, bi)
    hdc := DllCall("CreateCompatibleDC", "Ptr", 0, "Ptr")
    bits := 0
    hbm := DllCall("CreateDIBSection", "Ptr", hdc, "Ptr", bi, "UInt", 0, "Ptr*", &bits, "Ptr", 0, "UInt", 0, "Ptr")
    old := DllCall("SelectObject", "Ptr", hdc, "Ptr", hbm, "Ptr")
    loop H {
        yy := A_Index - 1
        loop W
            NumPut("UInt", px(A_Index - 1, yy), bits, (yy * W + A_Index - 1) * 4)
    }
    pt := Buffer(8), NumPut("Int", X, "Int", Y, pt)
    sz := Buffer(8), NumPut("Int", W, "Int", H, sz)
    src := Buffer(8, 0)
    blend := Buffer(4), NumPut("UChar", 0, "UChar", 0, "UChar", 255, "UChar", 1, blend)
    if !DllCall("UpdateLayeredWindow", "Ptr", g.Hwnd, "Ptr", 0, "Ptr", pt, "Ptr", sz, "Ptr", hdc, "Ptr", src, "UInt", 0, "Ptr", blend, "UInt", 2)
        FileAppend("UpdateLayeredWindow failed " A_LastError "`n", "*", "UTF-8")
    DllCall("SelectObject", "Ptr", hdc, "Ptr", old), DllCall("DeleteObject", "Ptr", hbm), DllCall("DeleteDC", "Ptr", hdc)
    return g
}
