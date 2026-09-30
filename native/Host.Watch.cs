using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    internal sealed class ChildInfo
    {
        public IntPtr H, Parent; public string Class, Text; public int Id; public Win.RECT R; public bool Visible, Enabled; public long Style;
    }

    internal sealed class WinState
    {
        public IntPtr Hwnd; public int Pid; public string ProcId; public long First, VisibleSince;
        public bool Visible, Handled; public string Class = "", Title = "", Kind = "";
    }

    internal sealed class WinInfo
    {
        public IntPtr Hwnd; public int Pid; public string Class, Title, Text, Kind; public Win.RECT R; public long Style, ExStyle; public bool Visible, Enabled;
        public List<ChildInfo> Children = new List<ChildInfo>();
        public List<string> Buttons = new List<string>();
    }

    internal sealed class Rule { public string Name; public Dict Match, Do; }

    internal sealed partial class Host
    {
        readonly Dictionary<IntPtr, WinState> _wins = new Dictionary<IntPtr, WinState>();
        List<Rule> _rules = new List<Rule>();
        // auto-capture policy (set via shots.auto)
        string _shotDir; long _shotEveryMs; long _nextAuto; bool _shotOnWindow, _shotOnDialog = true; int _shotMaxEdge = 0; string _shotTech = "auto";
        int _shotCounter;
        public long HangMs = 4000;

        // ------------------------------------------------------------------ rules

        public void SetRules(List<object> rules)
        {
            var list = new List<Rule>();
            foreach (object o in rules)
            {
                var d = o as Dict; if (d == null) continue;
                list.Add(new Rule { Name = J.Str(d, "name", "rule" + list.Count), Match = J.Obj(d, "match") ?? new Dict(), Do = J.Obj(d, "do") ?? new Dict() });
            }
            lock (_wins) _rules = list;
        }

        static bool Rx(string pattern, string input)
        {
            try { return Regex.IsMatch(input ?? "", pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline); } catch { return false; }
        }

        static bool MatchRule(Rule r, WinInfo w, WinState st)
        {
            var m = r.Match;
            if (m.ContainsKey("kind"))
            {
                var kinds = J.Strs(m, "kind"); if (kinds.Count == 0) kinds.Add(J.Str(m, "kind"));
                if (!kinds.Contains(w.Kind)) return false;
            }
            if (m.ContainsKey("class") && !Rx(J.Str(m, "class"), w.Class)) return false;
            if (m.ContainsKey("title") && !Rx(J.Str(m, "title"), w.Title)) return false;
            if (m.ContainsKey("text") && !Rx(J.Str(m, "text"), w.Text)) return false;
            if (m.ContainsKey("proc") && !string.Equals(J.Str(m, "proc"), st.ProcId, StringComparison.OrdinalIgnoreCase)) return false;
            if (m.ContainsKey("button"))
            {
                bool any = false; foreach (string b in w.Buttons) if (Rx(J.Str(m, "button"), b)) any = true;
                if (!any) return false;
            }
            return true;
        }

        // ------------------------------------------------------------------ inspection helpers

        public static List<ChildInfo> Children(IntPtr hwnd, int cap)
        {
            var list = new List<ChildInfo>();
            Win.EnumChildWindows(hwnd, delegate (IntPtr h, IntPtr l)
            {
                if (list.Count >= cap) return false;
                var c = new ChildInfo { H = h, Parent = Win.GetParent(h), Class = Win.GetClass(h), Text = Win.GetText(h), Id = Win.Id(h), Visible = Win.IsWindowVisible(h), Enabled = Win.IsWindowEnabled(h), Style = Win.GetLong(h, Win.GWL_STYLE) };
                Win.GetWindowRect(h, out c.R);
                list.Add(c); return true;
            }, IntPtr.Zero);
            return list;
        }

        static bool IsPushButton(ChildInfo c)
        {
            if (!c.Class.Equals("Button", StringComparison.OrdinalIgnoreCase)) return false;
            long s = c.Style & 0xF; return s == 0 || s == 1;   // BS_PUSHBUTTON / BS_DEFPUSHBUTTON
        }

        public WinInfo Inspect(IntPtr hwnd, int cap)
        {
            var w = new WinInfo { Hwnd = hwnd, Pid = Win.Pid(hwnd), Class = Win.GetClass(hwnd), Title = Win.GetText(hwnd), Visible = Win.IsWindowVisible(hwnd), Enabled = Win.IsWindowEnabled(hwnd),
                                  Style = Win.GetLong(hwnd, Win.GWL_STYLE), ExStyle = Win.GetLong(hwnd, Win.GWL_EXSTYLE) };
            Win.GetWindowRect(hwnd, out w.R);
            w.Children = Children(hwnd, cap);
            var text = new StringBuilder();
            foreach (var c in w.Children)
            {
                if (IsPushButton(c)) w.Buttons.Add(c.Text.Replace("&", ""));
                else if (c.Text.Length > 0 && c.Visible && !c.Class.Equals("Edit", StringComparison.OrdinalIgnoreCase)) { if (text.Length > 0) text.Append('\n'); text.Append(c.Text); }
            }
            w.Text = text.ToString();
            return w;
        }

        string ScriptNameOf(string procId)
        {
            Proc p = null; lock (_procs) if (procId != null) _procs.TryGetValue(procId, out p);
            return p != null ? p.ScriptName : null;
        }

        /// <summary>Structure-first classification (class, controls, the AHK line marker); English text is only a tie-breaker.</summary>
        string Classify(WinInfo w, string scriptName)
        {
            string cls = w.Class ?? "";
            if (cls.StartsWith("AutoHotkeyGUI", StringComparison.OrdinalIgnoreCase)) return "ahk-gui";
            if (cls.Equals("AutoHotkey", StringComparison.OrdinalIgnoreCase)) return "ahk-main";
            if (cls.StartsWith("tooltips_class", StringComparison.OrdinalIgnoreCase)) return "tooltip";
            if (cls == "#32770")
            {
                string body = (w.Text ?? "").TrimStart();
                bool titleIsScript = scriptName != null && string.Equals(w.Title, scriptName, StringComparison.OrdinalIgnoreCase);
                bool marker = body.IndexOf('▶') >= 0;                       // AHK's "▶ 12: code" marker line
                bool exitBtn = w.Buttons.Exists(b => b.Equals("ExitApp", StringComparison.OrdinalIgnoreCase) || b.Equals("Exit", StringComparison.OrdinalIgnoreCase));
                bool errWord = body.StartsWith("Error:") || body.StartsWith("Critical Error") || body.StartsWith("Error at line") || Regex.IsMatch(body, @"^(Error|Critical Error)\b");
                bool warnWord = body.StartsWith("Warning:") || body.StartsWith("Warning\r") || body.StartsWith("Warning\n");
                // Locale-independent: AHK v2's error dialog owns these fixed button ids (Reload/Edit/ExitApp/Help) and a RichEdit with id 501.
                bool ahkIds = w.Children.Exists(c => c.Id == 65405 || c.Id == 65400 || c.Id == 65401 || c.Id == 65411);
                if (ahkIds)
                {
                    var abort = w.Children.Find(c => c.Id == 2 && c.Class.Equals("Button", StringComparison.OrdinalIgnoreCase));
                    bool abortHidden = abort != null && !abort.Visible;   // warnings hide Abort; errors show it
                    return (abortHidden || warnWord) ? "ahk-warning" : "ahk-error";
                }
                if (warnWord && (titleIsScript || marker)) return "ahk-warning";
                if (marker && (titleIsScript || errWord || exitBtn)) return "ahk-error";
                if ((exitBtn || errWord) && titleIsScript) return "ahk-error";
                bool hasEdit = w.Children.Exists(c => c.Class.Equals("Edit", StringComparison.OrdinalIgnoreCase));
                bool fileish = w.Children.Exists(c => c.Class == "DUIViewWndClassName" || c.Class == "SHELLDLL_DefView" || c.Class == "ComboBoxEx32" || c.Class == "DirectUIHWND");
                if (fileish) return "fileselect";
                if (hasEdit && w.Buttons.Count >= 2) return "inputbox";
                return "msgbox";
            }
            return "window";
        }

        // ------------------------------------------------------------------ tick (desktop thread)

        void Tick()
        {
            var procs = new List<Proc>(); foreach (var p in AllProcs()) if (!p.Disposed) procs.Add(p);
            if (procs.Count == 0) return;
            var pidMap = new Dictionary<int, Proc>();
            foreach (var p in procs) foreach (int pid in JobPids(p.Job)) { pidMap[pid] = p; p.EverPids.Add(pid); }

            var top = new List<IntPtr>();
            Win.EnumDesktopWindows(Desk, delegate (IntPtr h, IntPtr l) { top.Add(h); return true; }, IntPtr.Zero);
            long now = Now;
            var alive = new HashSet<IntPtr>(top);
            foreach (IntPtr h in top)
            {
                int pid = Win.Pid(h); Proc p; pidMap.TryGetValue(pid, out p);
                WinState st;
                if (!_wins.TryGetValue(h, out st)) { st = new WinState { Hwnd = h, Pid = pid, ProcId = p != null ? p.Id : null, First = now }; _wins[h] = st; }
                bool vis = Win.IsWindowVisible(h);
                if (vis && !st.Visible)
                {
                    st.Visible = true; st.VisibleSince = now; st.Handled = false; st.Class = Win.GetClass(h); st.Title = Win.GetText(h);
                    Win.RECT r; Win.GetWindowRect(h, out r);
                    Emit("win.new", "hwnd", Hx(h), "pid", pid, "proc", st.ProcId, "class", st.Class, "title", st.Title, "rect", Rc(r));
                }
                else if (!vis && st.Visible) { st.Visible = false; Emit("win.hidden", "hwnd", Hx(h), "proc", st.ProcId); }
                long settle = _shotDir != null && (_shotOnWindow || _shotOnDialog) ? 200 : 60;
                if (st.Visible && !st.Handled && now - st.VisibleSince >= settle) { st.Handled = true; HandleWindow(st); }
            }
            var gone = new List<IntPtr>();
            foreach (var kv in _wins) if (!alive.Contains(kv.Key) || !Win.IsWindow(kv.Key)) gone.Add(kv.Key);
            foreach (IntPtr h in gone) { var st = _wins[h]; _wins.Remove(h); if (st.Visible) Emit("win.gone", "hwnd", Hx(h), "proc", st.ProcId, "class", st.Class, "title", st.Title); }

            foreach (var p in procs) HangCheck(p, top, now);
            if (_shotDir != null && _shotEveryMs > 0 && now >= _nextAuto)
            {
                _nextAuto = now + _shotEveryMs;
                try { AutoShot(IntPtr.Zero, "tick"); } catch { }
            }
        }

        static string Hx(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }
        static object[] Rc(Win.RECT r) { return new object[] { r.Left, r.Top, r.Right, r.Bottom }; }

        void HangCheck(Proc p, List<IntPtr> top, long now)
        {
            if (now < p.NextHangCheck || p.Exited) return;
            p.NextHangCheck = now + 1000;
            IntPtr target = IntPtr.Zero;
            foreach (IntPtr h in top) if (Win.Pid(h) == p.Pid && Win.IsWindowVisible(h)) { target = h; break; }
            if (target == IntPtr.Zero) return;
            bool ok = Win.IsResponsive(target, 250);
            if (!ok && !p.Hung) { p.Hung = true; p.HungSince = now; }
            if (!ok && p.Hung && now - p.HungSince >= HangMs && p.KillReason != "hung-reported")
            {
                p.KillReason = p.KillReason ?? "hung-reported";
                Emit("hung", "proc", p.Id, "hwnd", Hx(target), "forMs", now - p.HungSince);
                try { AutoShot(target, "hung"); } catch { }
            }
            if (ok && p.Hung) { p.Hung = false; if (p.KillReason == "hung-reported") p.KillReason = null; Emit("unhung", "proc", p.Id); }
        }

        // ------------------------------------------------------------------ window handling + rules

        void HandleWindow(WinState st)
        {
            IntPtr h = st.Hwnd;
            var wi = Inspect(h, 400);
            wi.Kind = Classify(wi, ScriptNameOf(st.ProcId)); st.Kind = wi.Kind;
            Emit("win.ready", "hwnd", Hx(h), "proc", st.ProcId, "kind", wi.Kind, "class", wi.Class, "title", wi.Title, "rect", Rc(wi.R), "children", wi.Children.Count);
            bool dialogish = wi.Kind != "window" && wi.Kind != "ahk-gui" && wi.Kind != "ahk-main" && wi.Kind != "tooltip";
            string shot = null;
            Rule rule = null;
            foreach (var r in _rules) if (MatchRule(r, wi, st)) { rule = r; break; }
            bool wantShot = rule != null && rule.Do.ContainsKey("shot") ? J.Bool(rule.Do, "shot", false) : (_shotDir != null && ((_shotOnDialog && dialogish) || (_shotOnWindow && wi.Kind != "tooltip")));
            if (wantShot) { try { shot = AutoShot(h, wi.Kind); } catch (Exception ex) { Emit("error", "where", "shot", "message", ex.Message); } }

            string action = "observed";
            if (rule != null) action = ApplyRule(rule, st, wi);
            if (dialogish || (rule != null && wi.Kind != "window"))
            {
                var ctl = new List<object>();
                int n = 0;
                foreach (var c in wi.Children) { if (n++ >= 60) break; ctl.Add(new object[] { c.Class, c.Text, c.Id, c.Visible ? 1 : 0 }); }
                Emit("dialog", "hwnd", Hx(h), "proc", st.ProcId, "kind", wi.Kind, "class", wi.Class, "title", wi.Title, "text", wi.Text,
                     "buttons", wi.Buttons, "controls", ctl, "rect", Rc(wi.R), "rule", rule != null ? rule.Name : null, "action", action,
                     "verdict", rule != null ? J.Str(rule.Do, "verdict") : null, "shot", shot);
            }
        }

        string ApplyRule(Rule r, WinState st, WinInfo wi)
        {
            var d = r.Do; IntPtr h = wi.Hwnd;
            var did = new List<string>();
            long delay = J.Long(d, "delayMs", 0); if (delay > 0) System.Threading.Thread.Sleep((int)Math.Min(delay, 5000));
            if (J.Bool(d, "ignore", false)) return "ignored";
            string text = J.Str(d, "type");
            if (text != null)
            {
                foreach (var c in wi.Children)
                    if (c.Class.Equals("Edit", StringComparison.OrdinalIgnoreCase)) { IntPtr ig; Win.SendMessageTimeout(c.H, Win.WM_SETTEXT, IntPtr.Zero, text, Win.SMTO_ABORTIFHUNG, 500, out ig); did.Add("typed"); break; }
            }
            object press = J.Get(d, "press");
            if (press != null)
            {
                string ps = Convert.ToString(press);
                bool ok;
                if (ps == "default") ok = PressDefault(h, wi);
                else if (ps == "safe") ok = PressSafe(h, wi);
                else if (ps == "first") ok = PressFirst(h, wi);
                else if (ps == "kill") { var p = ProcOf(st); if (p != null) KillProc(p, 0xE77, "rule:" + r.Name); ok = true; }
                else if (ps == "close") ok = Win.PostMessage(h, Win.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                else
                {
                    int id;
                    if (press is IDictionary<string, object>) { var pd = (Dict)press; ok = PressButton(h, wi, J.Str(pd, "button"), J.Int(pd, "id", -1)); }
                    else if (int.TryParse(ps, out id)) ok = PressButton(h, wi, null, id);
                    else ok = PressButton(h, wi, ps, -1);
                }
                did.Add((ok ? "pressed:" : "press-failed:") + ps);
            }
            if (J.Bool(d, "close", false)) { Win.PostMessage(h, Win.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); did.Add("closed"); }
            if (J.Bool(d, "kill", false)) { var p = ProcOf(st); if (p != null) KillProc(p, 0xE77, "rule:" + r.Name); did.Add("killed"); }
            return did.Count == 0 ? "matched" : string.Join(",", did.ToArray());
        }

        Proc ProcOf(WinState st) { lock (_procs) { Proc p; return st.ProcId != null && _procs.TryGetValue(st.ProcId, out p) ? p : null; } }

        static bool PressButton(IntPtr dlg, WinInfo wi, string text, int id)
        {
            foreach (var c in wi.Children)
            {
                if (!c.Class.Equals("Button", StringComparison.OrdinalIgnoreCase)) continue;
                bool hit = id >= 0 ? c.Id == id : string.Equals(c.Text.Replace("&", ""), text, StringComparison.OrdinalIgnoreCase);
                if (hit) return Win.PostMessage(dlg, Win.WM_COMMAND, new IntPtr(c.Id), c.H);
            }
            return false;
        }

        /// <summary>Least destructive answer: Cancel, No, Abort, Ignore, Continue, OK - never Yes/Retry. Falls back to the default button.</summary>
        static bool PressSafe(IntPtr dlg, WinInfo wi)
        {
            foreach (int id in new[] { 2, 7, 3, 5, 11, 1 })
                foreach (var c in wi.Children)
                    if (c.Id == id && c.Enabled && c.Class.Equals("Button", StringComparison.OrdinalIgnoreCase)) return Win.PostMessage(dlg, Win.WM_COMMAND, new IntPtr(id), c.H);
            return PressDefault(dlg, wi);
        }

        static bool PressFirst(IntPtr dlg, WinInfo wi)
        {
            foreach (var c in wi.Children) if (IsPushButton(c)) return Win.PostMessage(dlg, Win.WM_COMMAND, new IntPtr(c.Id), c.H);
            return Win.PostMessage(dlg, Win.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }

        static bool PressDefault(IntPtr dlg, WinInfo wi)
        {
            IntPtr r;
            if (Win.SendMessageTimeoutI(dlg, Win.DM_GETDEFID, IntPtr.Zero, IntPtr.Zero, Win.SMTO_ABORTIFHUNG, 500, out r) != IntPtr.Zero)
            {
                long v = r.ToInt64();
                if (((v >> 16) & 0xFFFF) == 0x534B)   // DC_HASDEFID
                {
                    int id = (int)(v & 0xFFFF);
                    foreach (var c in wi.Children)     // only trust a default id that actually has a control (plain OK boxes report IDOK but only own IDCANCEL)
                        if (c.Id == id) return Win.PostMessage(dlg, Win.WM_COMMAND, new IntPtr(id), c.H);
                }
            }
            return PressFirst(dlg, wi);
        }
    }
}
