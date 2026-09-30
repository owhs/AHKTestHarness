#Requires AutoHotkey v2.0
; ============================================================================
; AhkProbe.ahk - in-process probe for the ahkh test harness.
;
; Inject WITHOUT touching the target:   AutoHotkey.exe /include AhkProbe.ahk target.ahk
; or opt in from a script with one line: #Include <path>\AhkProbe.ahk
;
; Everything lives in classes Ahkh / AhkhJson so the target's namespace stays clean.
;
; Environment (set by the harness):
;   AHKH_PROBE_MODE   passive (default) : no timers -> never changes when the script would exit
;                     rpc               : polls a mailbox dir (needs a persistent script, e.g. a GUI)
;   AHKH_PROBE_DIR    mailbox dir (in\ and out\ subfolders) for rpc mode
;   AHKH_ONERROR      log (default: report, then normal AHK handling) | exit (report, ExitApp 3) | continue (report, suppress dialog)
;
; Output protocol (stdout, one line each):   AHKH|<kind>|<json>      kinds: error assert log step mark done
; ============================================================================

class AhkhJson {
    static Dump(v, maxDepth := 6, depth := 0) {
        t := Type(v)
        if (t = "String")
            return '"' AhkhJson.Esc(v) '"'
        if (t = "Integer" || t = "Float")
            return String(v)
        if (depth >= maxDepth)
            return '"<max depth>"'
        if (t = "Array") {
            s := ""
            for x in v {
                if (A_Index > 500) {
                    s .= ',"<truncated>"'
                    break
                }
                s .= (A_Index > 1 ? "," : "") AhkhJson.Dump(x, maxDepth, depth + 1)
            }
            return "[" s "]"
        }
        if (t = "Map") {
            s := "", n := 0
            for k, x in v {
                if (++n > 500) {
                    s .= ',"...":"<truncated>"'
                    break
                }
                s .= (n > 1 ? "," : "") '"' AhkhJson.Esc(String(k)) '":' AhkhJson.Dump(x, maxDepth, depth + 1)
            }
            return "{" s "}"
        }
        if (t = "Object") {
            s := "", n := 0
            for k, x in v.OwnProps() {
                s .= (n++ ? "," : "") '"' AhkhJson.Esc(String(k)) '":' AhkhJson.Dump(x, maxDepth, depth + 1)
            }
            return "{" s "}"
        }
        if (t = "Func" || t = "BoundFunc" || t = "Closure") {
            try
                return '"<' t ' ' AhkhJson.Esc(v.Name) '>"'
            return '"<' t '>"'
        }
        return '"<' AhkhJson.Esc(t) '>"'
    }

    static Esc(s) {
        s := StrReplace(s, "\", "\\")
        s := StrReplace(s, '"', '\"')
        s := StrReplace(s, "`r", "\r")
        s := StrReplace(s, "`n", "\n")
        s := StrReplace(s, "`t", "\t")
        loop 31 {
            if (A_Index = 9 || A_Index = 10 || A_Index = 13)
                continue
            s := StrReplace(s, Chr(A_Index), Format("\u{:04x}", A_Index))
        }
        return s
    }

    ; Parse JSON text into Map / Array / String / Number. true -> 1, false -> 0, null -> "".
    static Parse(text) {
        p := {i: 1, s: text}
        v := AhkhJson._Val(p)
        return v
    }

    static _Ws(p) {
        while (p.i <= StrLen(p.s) && InStr(" `t`r`n", SubStr(p.s, p.i, 1)))
            p.i++
    }

    static _Val(p) {
        AhkhJson._Ws(p)
        c := SubStr(p.s, p.i, 1)
        if (c = "{") {
            m := Map()
            p.i++
            AhkhJson._Ws(p)
            if (SubStr(p.s, p.i, 1) = "}") {
                p.i++
                return m
            }
            loop {
                AhkhJson._Ws(p)
                k := AhkhJson._Str(p)
                AhkhJson._Ws(p)
                p.i++   ; :
                m[k] := AhkhJson._Val(p)
                AhkhJson._Ws(p)
                d := SubStr(p.s, p.i, 1)
                p.i++
                if (d = "}")
                    return m
            }
        }
        if (c = "[") {
            a := []
            p.i++
            AhkhJson._Ws(p)
            if (SubStr(p.s, p.i, 1) = "]") {
                p.i++
                return a
            }
            loop {
                a.Push(AhkhJson._Val(p))
                AhkhJson._Ws(p)
                d := SubStr(p.s, p.i, 1)
                p.i++
                if (d = "]")
                    return a
            }
        }
        if (c = '"')
            return AhkhJson._Str(p)
        if (SubStr(p.s, p.i, 4) = "true") {
            p.i += 4
            return 1
        }
        if (SubStr(p.s, p.i, 5) = "false") {
            p.i += 5
            return 0
        }
        if (SubStr(p.s, p.i, 4) = "null") {
            p.i += 4
            return ""
        }
        RegExMatch(p.s, "S)-?\d+(\.\d+)?([eE][+-]?\d+)?", &m, p.i)
        if (!IsObject(m) || m.Pos != p.i)
            throw Error("JSON parse error at " p.i)
        p.i += m.Len
        return Number(m[0])
    }

    static _Str(p) {
        p.i++   ; opening quote
        out := ""
        loop {
            c := SubStr(p.s, p.i, 1)
            if (c = "")
                throw Error("JSON: unterminated string")
            p.i++
            if (c = '"')
                return out
            if (c = "\") {
                e := SubStr(p.s, p.i, 1)
                p.i++
                switch e {
                    case "n": out .= "`n"
                    case "r": out .= "`r"
                    case "t": out .= "`t"
                    case "b": out .= "`b"
                    case "f": out .= "`f"
                    case "u":
                        out .= Chr(Integer("0x" SubStr(p.s, p.i, 4)))
                        p.i += 4
                    default: out .= e
                }
            } else
                out .= c
        }
    }
}

class Ahkh {
    static Version := "0.1.0"
    static Dir := EnvGet("AHKH_PROBE_DIR")
    static Mode := EnvGet("AHKH_PROBE_MODE") || "passive"
    static OnErr := EnvGet("AHKH_ONERROR") || "log"
    static Guis := Map()          ; id -> {gui, events: Map(name -> [cb])}
    static Ctrls := Map()         ; id -> {ctrl, gid, events: Map(name -> [cb]), kind}
    static CtrlIds := Map()       ; ObjPtr(ctrl) -> id
    static GuiIds := Map()        ; ObjPtr(gui) -> id
    static Menus := []            ; [{menu, items: [{name, cb}]}]
    static NextId := 1
    static Pass := 0
    static Fail := 0
    static T0 := A_TickCount
    static _busy := false

    static __New() {
        try OnError(ObjBindMethod(Ahkh, "_OnError"), -1)
        Ahkh._WrapGui()
        Ahkh._WrapMenu()
        if (Ahkh.Mode = "rpc" && Ahkh.Dir != "") {
            DirCreate(Ahkh.Dir "\in")
            DirCreate(Ahkh.Dir "\out")
            SetTimer(ObjBindMethod(Ahkh, "_Poll"), 40)
        }
        Ahkh._Emit("log", '{"msg":"probe ready","mode":"' Ahkh.Mode '","pid":' ProcessExist() '}')
    }

    ; ------------------------------------------------------------------ output protocol
    static _Emit(kind, json) {
        try FileAppend("AHKH|" kind "|" json "`n", "*", "UTF-8")
    }

    static Log(msg) {
        Ahkh._Emit("log", '{"msg":"' AhkhJson.Esc(String(msg)) '"}')
    }

    static Mark(label) {
        Ahkh._Emit("mark", '{"label":"' AhkhJson.Esc(label) '","ms":' (A_TickCount - Ahkh.T0) '}')
    }

    ; ------------------------------------------------------------------ authored-test API
    static Assert(cond, msg := "assertion") {
        e := Error("", -1)
        if (cond) {
            Ahkh.Pass++
        } else {
            Ahkh.Fail++
            Ahkh._Emit("assert", '{"ok":false,"msg":"' AhkhJson.Esc(msg) '","file":"' AhkhJson.Esc(e.File) '","line":' e.Line '}')
        }
        return cond ? true : false
    }

    static Expect(actual, expected, msg := "") {
        e := Error("", -1)
        ok := (String(actual) == String(expected))
        if (ok) {
            Ahkh.Pass++
        } else {
            Ahkh.Fail++
            Ahkh._Emit("assert", '{"ok":false,"msg":"' AhkhJson.Esc(msg) '","expected":' AhkhJson.Dump(expected) ',"actual":' AhkhJson.Dump(actual) ',"file":"' AhkhJson.Esc(e.File) '","line":' e.Line '}')
        }
        return ok
    }

    static Step(name, fn) {
        t := A_TickCount
        try {
            fn()
            Ahkh._Emit("step", '{"name":"' AhkhJson.Esc(name) '","ok":true,"ms":' (A_TickCount - t) '}')
            Ahkh.Pass++
            return true
        } catch as err {
            Ahkh.Fail++
            Ahkh._Emit("step", '{"name":"' AhkhJson.Esc(name) '","ok":false,"ms":' (A_TickCount - t) ',"error":' Ahkh._ErrJson(err) '}')
            return false
        }
    }

    static WaitFor(fn, timeoutMs := 5000, intervalMs := 25) {
        end := A_TickCount + timeoutMs
        while (A_TickCount < end) {
            if (fn())
                return true
            Sleep(intervalMs)
        }
        return false
    }

    ; Micro-benchmark: runs fn n times, reports microseconds per call (QueryPerformanceCounter). Emits AHKH|bench|{...}.
    static Bench(label, fn, n := 1000) {
        f := 0, t0 := 0, t1 := 0
        DllCall("QueryPerformanceFrequency", "int64*", &f)
        DllCall("QueryPerformanceCounter", "int64*", &t0)
        loop n
            fn()
        DllCall("QueryPerformanceCounter", "int64*", &t1)
        us := (t1 - t0) * 1000000 / f / n
        Ahkh._Emit("bench", '{"label":"' AhkhJson.Esc(label) '","n":' n ',"usPerOp":' Round(us, 3) '}')
        return us
    }

    ; Time one call in milliseconds. Emits AHKH|bench|{"label":..,"ms":..}.
    static Time(label, fn) {
        f := 0, t0 := 0, t1 := 0
        DllCall("QueryPerformanceFrequency", "int64*", &f)
        DllCall("QueryPerformanceCounter", "int64*", &t0)
        r := fn()
        DllCall("QueryPerformanceCounter", "int64*", &t1)
        ms := (t1 - t0) * 1000 / f
        Ahkh._Emit("bench", '{"label":"' AhkhJson.Esc(label) '","n":1,"ms":' Round(ms, 3) '}')
        return r
    }

    static Done(exitCode?) {
        Ahkh._Emit("done", '{"pass":' Ahkh.Pass ',"fail":' Ahkh.Fail '}')
        ExitApp(IsSet(exitCode) ? exitCode : (Ahkh.Fail > 0 ? 1 : 0))
    }

    ; ------------------------------------------------------------------ errors
    static _ErrJson(err) {
        s := '{"message":"' AhkhJson.Esc(err.Message) '"'
        try s .= ',"what":"' AhkhJson.Esc(String(err.What)) '"'
        try s .= ',"file":"' AhkhJson.Esc(err.File) '","line":' err.Line
        try s .= ',"extra":"' AhkhJson.Esc(String(err.Extra)) '"'
        try s .= ',"stack":"' AhkhJson.Esc(err.Stack) '"'
        return s "}"
    }

    static _OnError(err, mode) {
        try Ahkh._Emit("error", Ahkh._ErrJson(err))
        if (Ahkh.OnErr = "exit")
            ExitApp(3)
        if (Ahkh.OnErr = "continue")
            return 1
        return 0
    }

    ; ------------------------------------------------------------------ recorders (GUI / menus)
    static _WrapGui() {
        for name in ["Add", "AddText", "AddEdit", "AddButton", "AddCheckbox", "AddRadio", "AddDropDownList", "AddDDL", "AddComboBox", "AddListBox", "AddListView", "AddTreeView", "AddTab", "AddTab2", "AddTab3", "AddSlider", "AddProgress", "AddPic", "AddPicture", "AddGroupBox", "AddLink", "AddHotkey", "AddDateTime", "AddMonthCal", "AddUpDown", "AddActiveX", "AddCustom", "AddStatusBar"] {
            try Ahkh._WrapAdd(name)
        }
        try Ahkh._WrapCtrlOnEvent()
        try Ahkh._WrapGuiOnEvent()
        for name in ["Show", "Destroy"] {
            try Ahkh._WrapGuiSimple(name)
        }
    }

    static _WrapAdd(name) {
        orig := Gui.Prototype.%name%
        Gui.Prototype.DefineProp(name, {Call: (this, args*) => Ahkh._OnAdd(this, orig(this, args*), name)})
    }

    static _WrapGuiSimple(name) {
        orig := Gui.Prototype.%name%
        Gui.Prototype.DefineProp(name, {Call: (this, args*) => (Ahkh._RegGui(this), orig(this, args*))})
    }

    static _RegGui(g) {
        p := ObjPtr(g)
        if Ahkh.GuiIds.Has(p)
            return Ahkh.GuiIds[p]
        id := "g" Ahkh.NextId++
        Ahkh.GuiIds[p] := id
        Ahkh.Guis[id] := {gui: g, events: Map()}
        return id
    }

    static _OnAdd(g, ctrl, kind) {
        gid := Ahkh._RegGui(g)
        try {
            p := ObjPtr(ctrl)
            if !Ahkh.CtrlIds.Has(p) {
                id := "c" Ahkh.NextId++
                Ahkh.CtrlIds[p] := id
                Ahkh.Ctrls[id] := {ctrl: ctrl, gid: gid, events: Map(), kind: kind}
            }
        }
        return ctrl
    }

    static _WrapCtrlOnEvent() {
        orig := Gui.Control.Prototype.OnEvent
        Gui.Control.Prototype.DefineProp("OnEvent", {Call: (this, ev, cb, rest*) => (Ahkh._RecCtrlEvent(this, ev, cb, rest*), orig(this, ev, cb, rest*))})
    }

    static _RecCtrlEvent(ctrl, ev, cb, addRem := 1) {
        try {
            p := ObjPtr(ctrl)
            if !Ahkh.CtrlIds.Has(p)
                return
            rec := Ahkh.Ctrls[Ahkh.CtrlIds[p]]
            if !rec.events.Has(ev)
                rec.events[ev] := []
            if (addRem != 0)
                rec.events[ev].Push(cb)
        }
    }

    static _WrapGuiOnEvent() {
        orig := Gui.Prototype.OnEvent
        Gui.Prototype.DefineProp("OnEvent", {Call: (this, ev, cb, rest*) => (Ahkh._RecGuiEvent(this, ev, cb, rest*), orig(this, ev, cb, rest*))})
    }

    static _RecGuiEvent(g, ev, cb, addRem := 1) {
        try {
            id := Ahkh._RegGui(g)
            rec := Ahkh.Guis[id]
            if !rec.events.Has(ev)
                rec.events[ev] := []
            if (addRem != 0)
                rec.events[ev].Push(cb)
        }
    }

    static _WrapMenu() {
        try {
            orig := Menu.Prototype.Add
            Menu.Prototype.DefineProp("Add", {Call: (this, args*) => (Ahkh._RecMenu(this, args*), orig(this, args*))})
        }
    }

    static _RecMenu(m, name?, cb?, opts?) {
        try {
            for rec in Ahkh.Menus {
                if (rec.menu = m) {
                    rec.items.Push({name: IsSet(name) ? name : "", cb: IsSet(cb) ? cb : ""})
                    return
                }
            }
            Ahkh.Menus.Push({menu: m, items: [{name: IsSet(name) ? name : "", cb: IsSet(cb) ? cb : ""}]})
        }
    }

    ; ------------------------------------------------------------------ RPC (mailbox)
    static _Poll() {
        if Ahkh._busy
            return
        Ahkh._busy := true
        try {
            loop files Ahkh.Dir "\in\*.json" {
                name := A_LoopFileName
                path := A_LoopFileFullPath
                txt := ""
                try txt := FileRead(path, "UTF-8")
                if (txt = "")
                    continue
                try FileDelete(path)
                out := ""
                try {
                    req := AhkhJson.Parse(txt)
                    res := Ahkh._Handle(req["cmd"], req)
                    out := '{"ok":true,"result":' AhkhJson.Dump(res) '}'
                } catch as err {
                    out := '{"ok":false,"error":' Ahkh._ErrJson(err) '}'
                }
                tmp := Ahkh.Dir "\out\" name ".tmp"
                try FileDelete(tmp)
                FileAppend(out, tmp, "UTF-8")
                FileMove(tmp, Ahkh.Dir "\out\" name, 1)
            }
        }
        Ahkh._busy := false
    }

    static _CtrlInfo(id, rec) {
        c := rec.ctrl
        info := Map("id", id, "gui", rec.gid, "kind", rec.kind)
        try info["type"] := c.Type
        try info["name"] := c.Name
        try info["hwnd"] := c.Hwnd
        try info["text"] := c.Text
        try info["value"] := c.Value
        try info["enabled"] := c.Enabled
        try info["visible"] := c.Visible
        try {
            c.GetPos(&x, &y, &w, &h)
            info["pos"] := [x, y, w, h]
        }
        evs := []
        for ev, cbs in rec.events
            evs.Push(Map("event", ev, "handlers", cbs.Length))
        info["events"] := evs
        return info
    }

    static _Handle(cmd, req) {
        switch cmd {
            case "ping":
                return Map("pid", ProcessExist(), "ahk", A_AhkVersion, "script", A_ScriptFullPath, "scriptHwnd", A_ScriptHwnd, "mode", Ahkh.Mode, "ms", A_TickCount - Ahkh.T0)
            case "guis":
                out := []
                for gid, grec in Ahkh.Guis {
                    g := grec.gui
                    gi := Map("id", gid)
                    try gi["hwnd"] := g.Hwnd
                    try gi["title"] := g.Title
                    try gi["visible"] := DllCall("IsWindowVisible", "ptr", g.Hwnd)
                    evs := []
                    for ev, cbs in grec.events
                        evs.Push(Map("event", ev, "handlers", cbs.Length))
                    gi["events"] := evs
                    cs := []
                    for cid, crec in Ahkh.Ctrls {
                        if (crec.gid = gid)
                            cs.Push(Ahkh._CtrlInfo(cid, crec))
                    }
                    gi["controls"] := cs
                    out.Push(gi)
                }
                return out
            case "menus":
                out := []
                for rec in Ahkh.Menus {
                    items := []
                    for it in rec.items {
                        cbn := ""
                        try cbn := (Type(it.cb) = "String") ? it.cb : it.cb.Name
                        items.Push(Map("name", it.name, "callback", cbn))
                    }
                    out.Push(Map("items", items))
                }
                return out
            case "fire":
                return Ahkh._Fire(req)
            case "call":
                return Ahkh._Call(req)
            case "get":
                name := req["name"]
                return %name%
            case "set":
                name := req["name"]
                %name% := req["value"]
                return 1
            case "hotkeys":
                ListHotkeys()
                Sleep(80)
                txt := ""
                try txt := ControlGetText("Edit1", "ahk_id " A_ScriptHwnd)
                try WinHide("ahk_id " A_ScriptHwnd)
                return txt
            case "menufire":
                mi := req["menu"] + 1
                ii := req["item"] + 1
                if (mi < 1 || mi > Ahkh.Menus.Length)
                    throw Error("no such menu " req["menu"])
                rec := Ahkh.Menus[mi]
                if (ii < 1 || ii > rec.items.Length)
                    throw Error("no such menu item " req["item"])
                it := rec.items[ii]
                cb := it.cb
                if (Type(cb) = "Menu")
                    return Map("called", 0, "note", "submenu: no callback")
                if !IsObject(cb)
                    return Map("called", 0, "note", "item has no callable callback")
                try {
                    cb(it.name, ii, rec.menu)
                    return Map("called", 1)
                } catch as err
                    return Map("called", 1, "errors", [Ahkh._ErrMap(err)])
            case "log":
                Ahkh.Log(req.Has("msg") ? req["msg"] : "")
                return 1
            case "exit":
                SetTimer(() => ExitApp(req.Has("code") ? req["code"] : 0), -10)
                return 1
        }
        throw Error("unknown probe command: " cmd)
    }

    static _Fire(req) {
        errors := []
        called := 0
        ev := req.Has("event") ? req["event"] : "Click"
        info := req.Has("info") ? req["info"] : 0
        if req.Has("ctrl") {
            id := req["ctrl"]
            if !Ahkh.Ctrls.Has(id)
                throw Error("no such control: " id)
            rec := Ahkh.Ctrls[id]
            if !rec.events.Has(ev)
                return Map("called", 0, "note", "no handler registered for " ev)
            for cb in rec.events[ev] {
                try {
                    cb(rec.ctrl, info)
                    called++
                } catch as err
                    errors.Push(Ahkh._ErrMap(err))
            }
        } else if req.Has("gui") {
            id := req["gui"]
            if !Ahkh.Guis.Has(id)
                throw Error("no such gui: " id)
            rec := Ahkh.Guis[id]
            if !rec.events.Has(ev)
                return Map("called", 0, "note", "no handler registered for " ev)
            for cb in rec.events[ev] {
                try {
                    cb(rec.gui)
                    called++
                } catch as err
                    errors.Push(Ahkh._ErrMap(err))
            }
        } else
            throw Error("fire needs ctrl or gui")
        return Map("called", called, "errors", errors)
    }

    static _Call(req) {
        name := req["fn"]
        f := %name%
        args := req.Has("args") ? req["args"] : []
        try {
            r := f(args*)
            return Map("ok", 1, "result", IsSet(r) ? r : "")
        } catch as err
            return Map("ok", 0, "error", Ahkh._ErrMap(err))
    }

    static _ErrMap(err) {
        m := Map("message", err.Message)
        try m["what"] := String(err.What)
        try m["file"] := err.File
        try m["line"] := err.Line
        try m["extra"] := String(err.Extra)
        try m["stack"] := err.Stack
        return m
    }
}
