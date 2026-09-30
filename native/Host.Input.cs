using System;
using System.Collections.Generic;
using System.Text;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>Window listing, control trees and message-based input. Input is posted as window messages (never SendInput),
    /// so it can only ever reach the hidden desktop and never moves the real cursor or takes focus.</summary>
    internal sealed partial class Host
    {
        static string KindOf(string cls, long style)
        {
            string c = (cls ?? "").ToLowerInvariant();
            if (c == "button")
            {
                long t = style & 0xF;
                if (t == 0 || t == 1) return "button";
                if (t == 2 || t == 3 || t == 5 || t == 6) return "checkbox";
                if (t == 4 || t == 9) return "radio";
                if (t == 7) return "groupbox";
                return "button";
            }
            if (c.StartsWith("edit") || c.StartsWith("richedit") || c == "scintilla") return "edit";
            if (c == "static") return "text";
            if (c == "combobox" || c == "comboboxex32") return "combo";
            if (c == "listbox") return "list";
            if (c == "syslistview32") return "listview";
            if (c == "systreeview32") return "treeview";
            if (c == "systabcontrol32") return "tab";
            if (c == "msctls_progress32") return "progress";
            if (c == "msctls_trackbar32") return "slider";
            if (c == "msctls_updown32") return "updown";
            if (c == "msctls_statusbar32") return "statusbar";
            if (c == "toolbarwindow32") return "toolbar";
            if (c == "syslink") return "link";
            if (c == "sysdatetimepick32") return "datetime";
            if (c == "sysmonthcal32") return "calendar";
            if (c.Contains("internet explorer_server") || c.Contains("chrome_widgetwin") || c.Contains("webview")) return "web";
            return "control";
        }

        Dict WinDict(IntPtr h)
        {
            Win.RECT r; Win.GetWindowRect(h, out r); Win.RECT cr; Win.GetClientRect(h, out cr);
            int pid = Win.Pid(h); string procId = null;
            foreach (var p in AllProcs()) if (!p.Disposed && p.EverPids.Contains(pid)) { procId = p.Id; break; }
            WinState st; string kind = null; if (_wins.TryGetValue(h, out st)) kind = st.Kind;
            uint dpi = 0; try { dpi = Win.GetDpiForWindow(h); } catch { }
            return J.O("hwnd", Hx(h), "pid", pid, "proc", procId, "class", Win.GetClass(h), "title", Win.GetText(h), "kind", kind,
                       "rect", Rc(r), "clientSize", new object[] { cr.Right, cr.Bottom }, "visible", Win.IsWindowVisible(h), "enabled", Win.IsWindowEnabled(h),
                       "minimized", Win.IsIconic(h), "maximized", Win.IsZoomed(h), "style", Win.GetLong(h, Win.GWL_STYLE), "exstyle", Win.GetLong(h, Win.GWL_EXSTYLE),
                       "dpi", dpi, "owner", Hx(Win.GetWindow(h, Win.GW_OWNER)), "responsive", Win.IsResponsive(h, 150));
        }

        public List<object> ListWindows(Dict a)
        {
            string procId = J.Str(a, "proc"); bool visibleOnly = J.Bool(a, "visible", true);
            return OnDesk(delegate
            {
                HashSet<int> pids = null;
                if (procId != null) pids = new HashSet<int>(JobPids(GetProc(procId).Job));
                var res = new List<object>();
                Win.EnumDesktopWindows(Desk, delegate (IntPtr h, IntPtr l)
                {
                    if (pids != null && !pids.Contains(Win.Pid(h))) return true;
                    if (visibleOnly && !Win.IsWindowVisible(h)) return true;
                    res.Add(WinDict(h)); return true;
                }, IntPtr.Zero);
                return res;
            });
        }

        Dict NodeDict(ChildInfo c, Win.RECT origin)
        {
            string kind = KindOf(c.Class, c.Style);
            var d = J.O("hwnd", Hx(c.H), "id", c.Id, "class", c.Class, "kind", kind, "text", c.Text, "visible", c.Visible, "enabled", c.Enabled,
                        "rect", new object[] { c.R.Left - origin.Left, c.R.Top - origin.Top, c.R.Right - c.R.Left, c.R.Bottom - c.R.Top },
                        "screenRect", Rc(c.R), "parent", Hx(c.Parent));
            long r;
            switch (kind)
            {
                case "checkbox": case "radio":
                    if (Win.Send(c.H, Win.BM_GETCHECK, 0, 0, out r, 300)) d["checked"] = r == 1 ? "checked" : r == 2 ? "indeterminate" : "unchecked"; break;
                case "combo":
                    if (Win.Send(c.H, Win.CB_GETCOUNT, 0, 0, out r, 300)) d["count"] = r;
                    if (Win.Send(c.H, Win.CB_GETCURSEL, 0, 0, out r, 300)) { d["selected"] = r; if (r >= 0) d["selectedText"] = ComboText(c.H, (int)r); }
                    break;
                case "list":
                    if (Win.Send(c.H, Win.LB_GETCOUNT, 0, 0, out r, 300)) d["count"] = r;
                    if (Win.Send(c.H, Win.LB_GETCURSEL, 0, 0, out r, 300)) d["selected"] = r;
                    break;
                case "tab":
                    if (Win.Send(c.H, Win.TCM_GETITEMCOUNT, 0, 0, out r, 300)) d["count"] = r;
                    if (Win.Send(c.H, Win.TCM_GETCURSEL, 0, 0, out r, 300)) d["selected"] = r;
                    break;
            }
            return d;
        }

        static string ComboText(IntPtr h, int idx)
        {
            long len; if (!Win.Send(h, Win.CB_GETLBTEXTLEN, idx, 0, out len, 300) || len <= 0) return "";
            var sb = new StringBuilder((int)len + 2); IntPtr ig;
            Win.SendMessageTimeout(h, Win.CB_GETLBTEXT, new IntPtr(idx), sb, Win.SMTO_ABORTIFHUNG, 300, out ig);
            return sb.ToString();
        }

        /// <summary>Flat control list for a window (parent links let the caller rebuild the tree).</summary>
        public Dict Tree(Dict a)
        {
            IntPtr h = ResolveWindow(a);
            return OnDesk(delegate
            {
                var w = WinDict(h);
                Win.RECT origin; Win.GetWindowRect(h, out origin);
                var nodes = new List<object>();
                foreach (var c in Children(h, J.Int(a, "cap", 1500))) nodes.Add(NodeDict(c, origin));
                w["controls"] = nodes;
                return w;
            });
        }

        IntPtr ResolveWindow(Dict a)
        {
            IntPtr h = J.Hwnd(a, "hwnd");
            if (h != IntPtr.Zero) return h;
            string procId = J.Str(a, "proc");
            if (procId != null || AllProcs().Length == 1) { h = MainWindow(GetProc(procId)); if (h != IntPtr.Zero) return h; }
            throw new ArgumentException("no window matched (pass hwnd or proc; the process may not have shown a window yet)");
        }

        public Dict WindowAt(Dict a)
        {
            int x = J.Int(a, "x", 0), y = J.Int(a, "y", 0);
            return OnDesk(delegate
            {
                IntPtr found = IntPtr.Zero;
                Win.EnumDesktopWindows(Desk, delegate (IntPtr h, IntPtr l)
                {
                    if (!Win.IsWindowVisible(h)) return true;
                    Win.RECT r; Win.GetWindowRect(h, out r);
                    if (x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom) { found = h; return false; }
                    return true;
                }, IntPtr.Zero);
                if (found == IntPtr.Zero) return J.O("hit", false);
                var chain = new List<object>(); chain.Add(WinDict(found));
                IntPtr cur = found;
                for (int i = 0; i < 12; i++)
                {
                    var pt = new Win.POINT { X = x, Y = y }; Win.ScreenToClient(cur, ref pt);
                    IntPtr child = Win.ChildWindowFromPointEx(cur, pt, Win.CWP_SKIPINVISIBLE | Win.CWP_SKIPTRANSPARENT);
                    if (child == IntPtr.Zero || child == cur) break;
                    chain.Add(WinDict(child)); cur = child;
                }
                return J.O("hit", true, "chain", chain);
            });
        }

        // ------------------------------------------------------------------ input (message based)

        static IntPtr DeepChildAt(IntPtr top, int sx, int sy)
        {
            IntPtr cur = top;
            for (int i = 0; i < 16; i++)
            {
                var pt = new Win.POINT { X = sx, Y = sy }; Win.ScreenToClient(cur, ref pt);
                IntPtr child = Win.ChildWindowFromPointEx(cur, pt, Win.CWP_SKIPINVISIBLE | Win.CWP_SKIPDISABLED | Win.CWP_SKIPTRANSPARENT);
                if (child == IntPtr.Zero || child == cur) break;
                cur = child;
            }
            return cur;
        }

        public Dict Click(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = ResolveWindow(a);
                Win.RECT r; Win.GetWindowRect(h, out r);
                int sx, sy;
                if (J.Has(a, "x") && J.Has(a, "y"))
                {
                    int x = J.Int(a, "x", 0), y = J.Int(a, "y", 0);
                    if (J.Bool(a, "screen", false)) { sx = x; sy = y; }
                    else { sx = r.Left + x; sy = r.Top + y; }      // x,y are relative to the window's top-left (matches the rects we report)
                }
                else { sx = (r.Left + r.Right) / 2; sy = (r.Top + r.Bottom) / 2; }
                IntPtr target = J.Bool(a, "exact", false) ? h : DeepChildAt(h, sx, sy);
                var pt = new Win.POINT { X = sx, Y = sy }; Win.ScreenToClient(target, ref pt);
                IntPtr lp = Win.MakeLParam(pt.X, pt.Y);
                string btn = J.Str(a, "button", "left"); bool dbl = J.Bool(a, "double", false);
                int down = btn == "right" ? Win.WM_RBUTTONDOWN : btn == "middle" ? Win.WM_MBUTTONDOWN : Win.WM_LBUTTONDOWN;
                int up = btn == "right" ? Win.WM_RBUTTONUP : btn == "middle" ? Win.WM_MBUTTONUP : Win.WM_LBUTTONUP;
                IntPtr mk = new IntPtr(btn == "right" ? Win.MK_RBUTTON : Win.MK_LBUTTON);
                Win.PostMessage(target, Win.WM_MOUSEMOVE, IntPtr.Zero, lp);
                Win.PostMessage(target, down, mk, lp); Win.PostMessage(target, up, IntPtr.Zero, lp);
                if (dbl) { Win.PostMessage(target, Win.WM_LBUTTONDBLCLK, mk, lp); Win.PostMessage(target, up, IntPtr.Zero, lp); }
                return J.O("target", Hx(target), "class", Win.GetClass(target), "clientX", pt.X, "clientY", pt.Y, "screenX", sx, "screenY", sy);
            });
        }

        public Dict Press(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = J.Hwnd(a, "hwnd"); if (h == IntPtr.Zero) throw new ArgumentException("hwnd required");
                // PostMessage on purpose: a synchronous BM_CLICK would block us if the click opens a modal dialog.
                bool ok = Win.PostMessage(h, Win.BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return J.O("posted", ok, "class", Win.GetClass(h), "text", Win.GetText(h));
            });
        }

        public Dict SetText(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = J.Hwnd(a, "hwnd"); string text = J.Str(a, "text", ""); string mode = J.Str(a, "mode", "replace");
                IntPtr ig; bool ok;
                if (mode == "append")
                {
                    Win.SendMessageTimeoutI(h, Win.EM_SETSEL, new IntPtr(-1), new IntPtr(-1), Win.SMTO_ABORTIFHUNG, 500, out ig);
                    ok = Win.SendMessageTimeout(h, Win.EM_REPLACESEL, new IntPtr(1), text, Win.SMTO_ABORTIFHUNG, 1000, out ig) != IntPtr.Zero;
                }
                else ok = Win.SendMessageTimeout(h, Win.WM_SETTEXT, IntPtr.Zero, text, Win.SMTO_ABORTIFHUNG, 1000, out ig) != IntPtr.Zero;
                // Let the parent know (EN_CHANGE = 0x300) so handlers written for user typing fire.
                IntPtr parent = Win.GetParent(h);
                if (parent != IntPtr.Zero && J.Bool(a, "notify", true)) Win.PostMessage(parent, Win.WM_COMMAND, Win.MakeLParam(Win.Id(h), 0x300), h);
                return J.O("ok", ok, "text", Win.GetText(h));
            });
        }

        static ushort Vk(string key, out bool ext)
        {
            ext = false; string k = key.ToLowerInvariant();
            switch (k)
            {
                case "enter": case "return": return 0x0D; case "tab": return 0x09; case "esc": case "escape": return 0x1B; case "space": return 0x20;
                case "backspace": case "bs": return 0x08; case "delete": case "del": ext = true; return 0x2E; case "insert": ext = true; return 0x2D;
                case "left": ext = true; return 0x25; case "up": ext = true; return 0x26; case "right": ext = true; return 0x27; case "down": ext = true; return 0x28;
                case "home": ext = true; return 0x24; case "end": ext = true; return 0x23; case "pgup": ext = true; return 0x21; case "pgdn": ext = true; return 0x22;
                case "shift": return 0x10; case "ctrl": case "control": return 0x11; case "alt": return 0x12; case "win": return 0x5B; case "apps": return 0x5D;
            }
            if (k.Length >= 2 && k[0] == 'f') { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n); }
            if (key.Length == 1) { short v = Win.VkKeyScan(key[0]); return (ushort)(v & 0xFF); }
            throw new ArgumentException("unknown key: " + key);
        }

        public Dict Key(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = ResolveWindow(a); string key = J.Str(a, "key");
                bool ext; ushort vk = Vk(key, out ext);
                uint scan = Win.MapVirtualKey(vk, 0);
                int count = Math.Max(1, J.Int(a, "repeat", 1));
                bool alt = J.Strs(a, "mods").Contains("alt");
                IntPtr target = J.Has(a, "hwnd") ? h : h;
                for (int i = 0; i < count; i++)
                {
                    long lpDown = 1 | (scan << 16) | (ext ? 1L << 24 : 0) | (alt ? 1L << 29 : 0);
                    long lpUp = 1 | (scan << 16) | (ext ? 1L << 24 : 0) | (1L << 30) | (1L << 31) | (alt ? 1L << 29 : 0);
                    Win.PostMessage(target, alt ? Win.WM_SYSKEYDOWN : Win.WM_KEYDOWN, new IntPtr(vk), new IntPtr(lpDown));
                    if (key.Length == 1 && !J.Strs(a, "mods").Contains("ctrl")) Win.PostMessage(target, Win.WM_CHAR, new IntPtr(key[0]), new IntPtr(lpDown));
                    else if (vk == 0x0D) Win.PostMessage(target, Win.WM_CHAR, new IntPtr(13), new IntPtr(lpDown));
                    else if (vk == 0x09) Win.PostMessage(target, Win.WM_CHAR, new IntPtr(9), new IntPtr(lpDown));
                    else if (vk == 0x1B) Win.PostMessage(target, Win.WM_CHAR, new IntPtr(27), new IntPtr(lpDown));
                    else if (vk == 0x08) Win.PostMessage(target, Win.WM_CHAR, new IntPtr(8), new IntPtr(lpDown));
                    Win.PostMessage(target, alt ? Win.WM_SYSKEYUP : Win.WM_KEYUP, new IntPtr(vk), new IntPtr(lpUp));
                }
                return J.O("posted", true, "vk", vk);
            });
        }

        public Dict Type(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = ResolveWindow(a); string text = J.Str(a, "text", "");
                foreach (char c in text)
                {
                    if (c == '\r') continue;
                    if (c == '\n') { Win.PostMessage(h, Win.WM_KEYDOWN, new IntPtr(0x0D), IntPtr.Zero); Win.PostMessage(h, Win.WM_CHAR, new IntPtr(13), IntPtr.Zero); Win.PostMessage(h, Win.WM_KEYUP, new IntPtr(0x0D), IntPtr.Zero); }
                    else Win.PostMessage(h, Win.WM_CHAR, new IntPtr(c), new IntPtr(1));
                }
                return J.O("posted", text.Length);
            });
        }

        public Dict Select(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = J.Hwnd(a, "hwnd"); string cls = Win.GetClass(h).ToLowerInvariant();
                int index = J.Int(a, "index", -1); string text = J.Str(a, "text");
                IntPtr parent = Win.GetParent(h); int id = Win.Id(h); long r;
                if (cls == "combobox")
                {
                    if (index < 0 && text != null) { var sb = text; IntPtr ig; Win.SendMessageTimeout(h, Win.CB_FINDSTRINGEXACT, new IntPtr(-1), sb, Win.SMTO_ABORTIFHUNG, 500, out ig); index = (int)ig.ToInt64(); }
                    Win.Send(h, Win.CB_SETCURSEL, index, 0, out r, 800);
                    Win.PostMessage(parent, Win.WM_COMMAND, Win.MakeLParam(id, 1 /*CBN_SELCHANGE*/), h);
                }
                else if (cls == "listbox")
                {
                    if (index < 0 && text != null) { IntPtr ig; Win.SendMessageTimeout(h, Win.LB_FINDSTRINGEXACT, new IntPtr(-1), text, Win.SMTO_ABORTIFHUNG, 500, out ig); index = (int)ig.ToInt64(); }
                    Win.Send(h, Win.LB_SETCURSEL, index, 0, out r, 800);
                    Win.PostMessage(parent, Win.WM_COMMAND, Win.MakeLParam(id, 1 /*LBN_SELCHANGE*/), h);
                }
                else if (cls == "systabcontrol32") Win.Send(h, Win.TCM_SETCURSEL, index, 0, out r, 800);
                else throw new ArgumentException("select supports ComboBox/ListBox/SysTabControl32 (got " + Win.GetClass(h) + "); use uia.act for others");
                return J.O("index", index);
            });
        }

        public Dict Check(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = J.Hwnd(a, "hwnd"); string want = J.Str(a, "state", "toggle"); long cur;
                Win.Send(h, Win.BM_GETCHECK, 0, 0, out cur, 300);
                bool isOn = cur == 1;
                bool flip = want == "toggle" || (want == "true" && !isOn) || (want == "false" && isOn) || (want == "on" && !isOn) || (want == "off" && isOn);
                if (flip) Win.PostMessage(h, Win.BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return J.O("was", cur == 1, "toggled", flip);
            });
        }

        public Dict WinAction(Dict a, string action)
        {
            return OnDesk(delegate
            {
                IntPtr h = ResolveWindow(a);
                switch (action)
                {
                    case "close": Win.PostMessage(h, Win.WM_SYSCOMMAND, new IntPtr(Win.SC_CLOSE), IntPtr.Zero); break;
                    case "wmclose": Win.PostMessage(h, Win.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); break;
                    case "minimize": Win.ShowWindowAsync(h, Win.SW_MINIMIZE); break;
                    case "maximize": Win.ShowWindowAsync(h, Win.SW_SHOWMAXIMIZED); break;
                    case "restore": Win.ShowWindowAsync(h, Win.SW_RESTORE); break;
                    case "move":
                        {
                            Win.RECT r; Win.GetWindowRect(h, out r);
                            int x = J.Int(a, "x", r.Left), y = J.Int(a, "y", r.Top), w = J.Int(a, "w", r.Right - r.Left), hh = J.Int(a, "h", r.Bottom - r.Top);
                            Win.SetWindowPos(h, IntPtr.Zero, x, y, w, hh, Win.SWP_NOZORDER | Win.SWP_NOACTIVATE); break;
                        }
                }
                return J.O("ok", true);
            });
        }

        /// <summary>Raw message escape hatch. post=true is asynchronous; otherwise SendMessageTimeout.</summary>
        public Dict RawMessage(Dict a)
        {
            return OnDesk(delegate
            {
                IntPtr h = J.Hwnd(a, "hwnd"); int msg = (int)J.Long(a, "msg", 0);
                long w = J.Long(a, "wparam", 0), l = J.Long(a, "lparam", 0);
                if (J.Bool(a, "post", true)) return J.O("posted", Win.PostMessage(h, msg, new IntPtr(w), new IntPtr(l)));
                long res; bool ok = Win.Send(h, msg, w, l, out res, (uint)J.Long(a, "timeoutMs", 1000));
                return J.O("ok", ok, "result", res);
            });
        }
    }
}
