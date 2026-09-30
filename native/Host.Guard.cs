using System;
using System.Collections.Generic;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>
    /// Watches the USER'S desktop (the one this host process started on) while tests run.
    /// It only reports things it can attribute to our job processes: they own the foreground window, own a visible window on the
    /// user's desktop, or own the clipboard. Those are the ways a target can annoy the person at the keyboard.
    /// </summary>
    internal sealed partial class Host
    {
        Thread _guardThread;
        readonly List<Dict> _violations = new List<Dict>();
        readonly HashSet<string> _violationKeys = new HashSet<string>();
        Win.POINT _cursor0; uint _clipSeq0; long _clipChangesByUs; IntPtr _fg0; string _guardError;

        void StartGuard()
        {
            Win.GetCursorPos(out _cursor0); _clipSeq0 = Win.GetClipboardSequenceNumber(); _fg0 = Win.GetForegroundWindow();
            _guardThread = new Thread(GuardLoop) { IsBackground = true, Name = "guard" };
            _guardThread.Start();
            StartClipGuard();
        }

        HashSet<int> AllOurPids()
        {
            var s = new HashSet<int>();
            foreach (var p in AllProcs())
            {
                if (p.Disposed) continue;
                foreach (int x in JobPids(p.Job)) s.Add(x);
                if (!p.Exited) foreach (int x in p.EverPids) s.Add(x);
            }
            return s;
        }

        void Violation(string key, string kind, params object[] kv)
        {
            lock (_violations)
            {
                if (!_violationKeys.Add(key)) return;
                var d = J.O("kind", kind, "t", Now);
                for (int i = 0; i + 1 < kv.Length; i += 2) d[Convert.ToString(kv[i])] = kv[i + 1];
                _violations.Add(d);
                var args = new List<object> { "kind", kind };
                args.AddRange(kv);
                Emit("guard", args.ToArray());
            }
        }

        void GuardLoop()
        {
            while (!_stop)
            {
                try
                {
                    var pids = AllOurPids();
                    if (pids.Count > 0)
                    {
                        IntPtr fg = Win.GetForegroundWindow();
                        if (fg != IntPtr.Zero && pids.Contains(Win.Pid(fg)))
                            Violation("fg:" + fg.ToInt64(), "foreground-stolen", "hwnd", Hx(fg), "class", Win.GetClass(fg), "title", Win.GetText(fg));
                        Win.EnumWindows(delegate (IntPtr h, IntPtr l)
                        {
                            if (Win.IsWindowVisible(h) && pids.Contains(Win.Pid(h)))
                                Violation("vis:" + h.ToInt64(), "window-on-user-desktop", "hwnd", Hx(h), "class", Win.GetClass(h), "title", Win.GetText(h));
                            return true;
                        }, IntPtr.Zero);
                    }
                }
                catch (Exception ex) { _guardError = ex.Message; }
                Thread.Sleep(100);
            }
        }

        public Dict GuardReport()
        {
            if (StationMode) return J.O("mode", "station", "violations", new List<object>(), "count", 0, "note", "private window station: the target has its own clipboard/atoms/hooks and cannot reach the user's session");
            Win.POINT c; Win.GetCursorPos(out c);
            List<object> v; lock (_violations) v = new List<object>(_violations.ToArray());
            return J.O("violations", v, "count", v.Count, "cursorMoved", c.X != _cursor0.X || c.Y != _cursor0.Y,
                       "clipboardChangedByTarget", _clipChangesByUs, "clipboardSeqDelta", Win.GetClipboardSequenceNumber() - _clipSeq0, "clipboard", ClipStatus(),
                       "foregroundChanged", Win.GetForegroundWindow() != _fg0, "error", _guardError);
        }

        public Dict GuardReset()
        {
            lock (_violations) { _violations.Clear(); _violationKeys.Clear(); }
            Win.GetCursorPos(out _cursor0); _clipSeq0 = Win.GetClipboardSequenceNumber(); _fg0 = Win.GetForegroundWindow(); _clipChangesByUs = 0;
            return J.O("ok", true);
        }

        /// <summary>State of the interactive session as seen by a process on it (run in --images-only mode): used to prove nothing changed.</summary>
        public static Dict SessionSnapshot()
        {
            Win.POINT c; Win.GetCursorPos(out c); IntPtr fg = Win.GetForegroundWindow();
            return J.O("clipboardSeq", Win.GetClipboardSequenceNumber(), "foreground", "0x" + fg.ToInt64().ToString("X"), "foregroundPid", fg == IntPtr.Zero ? 0 : Win.Pid(fg),
                       "cursor", new object[] { c.X, c.Y }, "foregroundTitle", fg == IntPtr.Zero ? "" : Win.GetText(fg));
        }

        /// <summary>Lists desktops in our window station (ours are AHKH_*), for diagnostics.</summary>
        public static List<object> ListDesktops()
        {
            var l = new List<object>();
            Win.EnumDesktops(Win.GetProcessWindowStation(), delegate (string n, IntPtr p) { l.Add(n); return true; }, IntPtr.Zero);
            return l;
        }
    }
}
