using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text.RegularExpressions;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>Screenshots. Everything here runs on the desktop thread (the DCs belong to the hidden desktop).</summary>
    internal sealed partial class Host
    {
        public void SetAutoShots(Dict a)
        {
            _shotDir = J.Str(a, "dir");
            if (_shotDir != null) Directory.CreateDirectory(_shotDir);
            _shotEveryMs = J.Long(a, "everyMs", 0);
            _nextAuto = Now + _shotEveryMs;
            _shotOnWindow = J.Bool(a, "onWindow", false);
            _shotOnDialog = J.Bool(a, "onDialog", true);
            _shotMaxEdge = J.Int(a, "maxEdge", 0);
            _shotTech = J.Str(a, "technique", "auto");
        }

        static string Slug(string s) { return Regex.Replace(s ?? "shot", @"[^A-Za-z0-9_.-]+", "-").Trim('-'); }

        string NextShotPath(string label, string dir)
        {
            int n = System.Threading.Interlocked.Increment(ref _shotCounter);
            return Path.Combine(dir ?? _shotDir, string.Format("{0:D3}_{1:D6}ms_{2}.png", n, Now, Slug(label)));
        }

        /// <summary>Shot into the auto directory. hwnd == 0 means the whole desktop.</summary>
        public string AutoShot(IntPtr hwnd, string label)
        {
            if (_shotDir == null) return null;
            var a = new Dict { { "label", label }, { "maxEdge", _shotMaxEdge }, { "tech", _shotTech } };
            if (hwnd == IntPtr.Zero) a["desktop"] = true; else a["hwnd"] = hwnd.ToInt64();
            var r = Shot(a);
            return J.Str(r, "path");
        }

        public Dict Shot(Dict a)
        {
            IntPtr h = J.Hwnd(a, "hwnd");
            string procId = J.Str(a, "proc");
            bool desktop = J.Bool(a, "desktop", false);
            if (h == IntPtr.Zero && !desktop && procId != null) h = MainWindow(GetProc(procId));
            if (h == IntPtr.Zero) desktop = true;
            string tech = J.Str(a, "tech", "auto");
            string label = J.Str(a, "label", desktop ? "desktop" : "window");
            string path = J.Str(a, "path");
            bool client = J.Bool(a, "client", false);
            int maxEdge = J.Int(a, "maxEdge", 0);
            double scale = J.Dbl(a, "scale", 1.0);
            var rect = J.Arr(a, "rect");
            string usedTech; bool blank; int ow, oh;
            Win.RECT origin = new Win.RECT();
            using (Bitmap bmp = desktop ? CaptureDesktop(tech, out usedTech, out blank) : CaptureWindow(h, client, tech, out usedTech, out blank))
            {
                if (!desktop) { if (client) { Win.RECT cr; Win.GetClientRect(h, out cr); Win.POINT pt = new Win.POINT(); Win.ClientToScreen(h, ref pt); origin.Left = pt.X; origin.Top = pt.Y; } else Win.GetWindowRect(h, out origin); }
                Bitmap cur = bmp; Bitmap owned = null;
                if (rect.Count == 4)
                {
                    int x = Convert.ToInt32(rect[0]), y = Convert.ToInt32(rect[1]), w = Convert.ToInt32(rect[2]), hh = Convert.ToInt32(rect[3]);
                    if (J.Bool(a, "screenRect", false)) { x -= origin.Left; y -= origin.Top; }
                    var r = Rectangle.Intersect(new Rectangle(x, y, w, hh), new Rectangle(0, 0, bmp.Width, bmp.Height));
                    if (r.Width > 0 && r.Height > 0) { owned = bmp.Clone(r, PixelFormat.Format32bppArgb); cur = owned; }
                }
                double s = scale;
                if (maxEdge > 0 && Math.Max(cur.Width, cur.Height) > maxEdge && rect.Count != 4) s = Math.Min(s, (double)maxEdge / Math.Max(cur.Width, cur.Height));
                Bitmap scaled = null;
                if (Math.Abs(s - 1.0) > 0.001) { scaled = Imaging.Resize(cur, s); cur = scaled; }
                if (path == null)
                {
                    if (_shotDir == null) throw new ArgumentException("no path given and no shot dir configured");
                    path = NextShotPath(label, null);
                }
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
                cur.Save(path, ImageFormat.Png);
                ow = cur.Width; oh = cur.Height;
                if (scaled != null) scaled.Dispose(); if (owned != null) owned.Dispose();
            }
            var res = J.O("path", path, "width", ow, "height", oh, "technique", usedTech, "blank", blank, "target", desktop ? "desktop" : Hx(h),
                          "originX", origin.Left, "originY", origin.Top);
            Emit("shot", "path", path, "label", label, "target", desktop ? "desktop" : Hx(h), "technique", usedTech, "blank", blank, "w", ow, "h", oh);
            return res;
        }

        public IntPtr MainWindow(Proc p)
        {
            return OnDesk(delegate
            {
                IntPtr best = IntPtr.Zero; long bestArea = -1;
                var pids = new HashSet<int>(JobPids(p.Job));
                Win.EnumDesktopWindows(Desk, delegate (IntPtr h, IntPtr l)
                {
                    if (!pids.Contains(Win.Pid(h)) || !Win.IsWindowVisible(h)) return true;
                    string cls = Win.GetClass(h); if (cls.StartsWith("tooltips_class") || cls == "#32770" && best != IntPtr.Zero) return true;
                    Win.RECT r; Win.GetWindowRect(h, out r);
                    long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
                    if (area > bestArea) { bestArea = area; best = h; }
                    return true;
                }, IntPtr.Zero);
                return best;
            });
        }

        // ------------------------------------------------------------------ capture

        Bitmap CaptureWindow(IntPtr h, bool clientOnly, string tech, out string used, out bool blank)
        {
            Win.RECT r;
            if (!Win.GetWindowRect(h, out r)) throw new InvalidOperationException("window gone: " + Hx(h));
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (clientOnly) { Win.RECT cr; Win.GetClientRect(h, out cr); w = cr.Right; hh = cr.Bottom; }
            if (w <= 0 || hh <= 0 || w > 16000 || hh > 16000) throw new InvalidOperationException("bad window size " + w + "x" + hh + (Win.IsIconic(h) ? " (minimised)" : ""));
            var order = new List<string>();
            if (tech == "auto") order.AddRange(new[] { "printwindow-full", "printwindow", "windowdc", "screen" }); else order.Add(tech);
            Bitmap last = null; used = order[0]; blank = true;
            foreach (string t in order)
            {
                var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
                bool ok = false;
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Black);
                    IntPtr hdc = g.GetHdc();
                    try
                    {
                        if (t == "printwindow-full") ok = Win.PrintWindow(h, hdc, Win.PW_RENDERFULLCONTENT | (clientOnly ? Win.PW_CLIENTONLY : 0));
                        else if (t == "printwindow") ok = Win.PrintWindow(h, hdc, clientOnly ? Win.PW_CLIENTONLY : 0);
                        else if (t == "windowdc")
                        {
                            IntPtr sdc = clientOnly ? Win.GetDC(h) : Win.GetWindowDC(h);
                            if (sdc != IntPtr.Zero) { ok = Win.BitBlt(hdc, 0, 0, w, hh, sdc, 0, 0, Win.SRCCOPY); Win.ReleaseDC(h, sdc); }
                        }
                        else if (t == "screen")
                        {
                            IntPtr sdc = Win.GetDC(IntPtr.Zero);
                            if (sdc != IntPtr.Zero)
                            {
                                int sx = r.Left, sy = r.Top;
                                if (clientOnly) { var pt = new Win.POINT(); Win.ClientToScreen(h, ref pt); sx = pt.X; sy = pt.Y; }
                                ok = Win.BitBlt(hdc, 0, 0, w, hh, sdc, sx, sy, Win.SRCCOPY); Win.ReleaseDC(IntPtr.Zero, sdc);
                            }
                        }
                    }
                    finally { g.ReleaseHdc(hdc); }
                }
                if (last != null) last.Dispose();
                last = bmp; used = t; blank = !ok || IsBlank(bmp);
                if (!blank) break;
            }
            return last;
        }

        Bitmap CaptureDesktop(string tech, out string used, out bool blank)
        {
            int w = Math.Max(1, ScreenW), h = Math.Max(1, ScreenH);
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            if (tech == "bitblt")
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc(); IntPtr sdc = Win.GetDC(IntPtr.Zero);
                    try { if (sdc != IntPtr.Zero) Win.BitBlt(hdc, 0, 0, w, h, sdc, 0, 0, Win.SRCCOPY); }
                    finally { if (sdc != IntPtr.Zero) Win.ReleaseDC(IntPtr.Zero, sdc); g.ReleaseHdc(hdc); }
                }
                used = "bitblt"; blank = IsBlank(bmp); return bmp;
            }
            // composite: PrintWindow every visible top-level window, bottom of the z-order first.
            var tops = new List<IntPtr>();
            Win.EnumDesktopWindows(Desk, delegate (IntPtr x, IntPtr l) { if (Win.IsWindowVisible(x) && !Win.GetClass(x).StartsWith("tooltips_class")) tops.Add(x); return true; }, IntPtr.Zero);
            tops.Reverse();
            int drawn = 0;
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.FromArgb(32, 34, 40));
                foreach (IntPtr wnd in tops)
                {
                    try
                    {
                        string t2; bool b2; Win.RECT r; Win.GetWindowRect(wnd, out r);
                        if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0 || Win.IsIconic(wnd)) continue;
                        using (var wb = CaptureWindow(wnd, false, "auto", out t2, out b2)) { g.DrawImageUnscaled(wb, r.Left, r.Top); drawn++; }
                    }
                    catch { }
                }
            }
            used = drawn > 0 ? "composite" : "empty"; blank = drawn == 0;
            return bmp;
        }

        /// <summary>True when every sampled pixel is identical (nothing was painted).</summary>
        public static bool IsBlank(Bitmap bmp)
        {
            var bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stepX = Math.Max(1, bmp.Width / 32), stepY = Math.Max(1, bmp.Height / 32);
                int first = System.Runtime.InteropServices.Marshal.ReadInt32(bd.Scan0);
                for (int y = 0; y < bmp.Height; y += stepY)
                    for (int x = 0; x < bmp.Width; x += stepX)
                        if (System.Runtime.InteropServices.Marshal.ReadInt32(bd.Scan0, y * bd.Stride + x * 4) != first) return false;
                return true;
            }
            finally { bmp.UnlockBits(bd); }
        }
    }
}
