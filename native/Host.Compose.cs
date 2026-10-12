using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>One window's pixels (straight, non-premultiplied ARGB) and where they go on the screen.</summary>
    internal sealed class Layer
    {
        public int X, Y, W, H; public int[] Px; public string Method, Note;
    }

    /// <summary>
    /// "Composed" screenshots: what the screen would show if the hidden desktop were the input desktop.
    ///
    /// Why: DWM keeps composing the windows of a non-input desktop (their visual trees, layered content, DirectComposition and
    /// thumbnails exist), but it never presents that desktop, so screen BitBlt reads black, WGC refuses the windows (item size 0,
    /// StartCapture = ERROR_INVALID_STATE) and Desktop Duplication only sees the input desktop. What DOES work (measured, build 26300):
    ///   - DwmRegisterThumbnail(our window, any window of the hidden desktop) succeeds, and
    ///   - PrintWindow(our window, PW_RENDERFULLCONTENT) makes DWM render our window *including the thumbnail visual*,
    ///     even when our window is cloaked and off screen.
    /// So every window is rendered by DWM itself (per-pixel alpha of UpdateLayeredWindow windows, DComp trees, #147 shared thumbnails,
    /// DX content, rounded corners and DWM borders) into two cloaked host windows painted black and white; the two renders give the
    /// exact alpha (difference matting). Windows are then stacked in z-order with the usual "over" operator.
    /// Gaps filled by hand: constant alpha / colour key of SetLayeredWindowAttributes windows (thumbnails ignore them) and windows
    /// excluded from capture (SetWindowDisplayAffinity: their thumbnail is black) - those come from their redirection surface
    /// (DwmGetDxSharedSurface + D3D11). An excluded *UpdateLayeredWindow* window has neither: it is reported in "unreadable"
    /// (the probe can lift its own exclusion for the shot, see Ahkh.Shot / session.shot).
    ///
    /// Everything runs on the "comp" thread: attached to the hidden desktop, owns the host windows and pumps messages (so other
    /// processes sending WM_GETTEXT etc. to our windows never block). It also owns a message-only window that in-process probes
    /// reach with WM_COPYDATA ("AHKH_HOST_HWND") to ask for a shot of their own desktop.
    /// </summary>
    internal sealed partial class Host
    {
        Thread _compThread;
        readonly BlockingCollection<Action> _cq = new BlockingCollection<Action>();
        readonly AutoResetEvent _cqEvt = new AutoResetEvent(false);
        readonly ManualResetEvent _compReady = new ManualResetEvent(false);
        IntPtr _msgWnd, _hostB, _hostW; int _hostCx, _hostCy;
        Win.WndProc _compProc;
        static readonly int SelfPid = Process.GetCurrentProcess().Id;
        const int CopyDataMagic = 0x484B4841;   // 'AHKH'
        public IntPtr HostMsgWindow { get { return _msgWnd; } }

        /// <summary>Windows the harness itself owns (compositor hosts): never listed, shot or treated as the target's.</summary>
        public static bool IsOwnWindow(IntPtr h) { return Win.Pid(h) == SelfPid; }

        void StartCompositor()
        {
            _compThread = new Thread(CompLoop) { IsBackground = true, Name = "comp" };
            _compThread.Start();
            _compReady.WaitOne(5000);
        }

        void CompLoop()
        {
            bool ok = Win.SetThreadDesktop(Desk);
            try
            {
                if (ok)
                {
                    _compProc = CompWndProc;
                    IntPtr inst = Marshal.GetHINSTANCE(typeof(Host).Module);
                    foreach (string cls in new[] { "AhkhHostMsg", "AhkhCompositorB", "AhkhCompositorW" })
                    {
                        var wc = new Win.WNDCLASSEX { cbSize = Marshal.SizeOf(typeof(Win.WNDCLASSEX)), lpfnWndProc = _compProc, hInstance = inst, lpszClassName = cls,
                                                      hbrBackground = cls == "AhkhCompositorW" ? Win.GetStockObject(0 /*WHITE_BRUSH*/) : Win.GetStockObject(4 /*BLACK_BRUSH*/) };
                        Win.RegisterClassEx(ref wc);
                    }
                    _msgWnd = Win.CreateWindowEx(0, "AhkhHostMsg", "ahkh host " + DeskName, 0, 0, 0, 0, 0, Win.HWND_MESSAGE, IntPtr.Zero, inst, IntPtr.Zero);
                }
            }
            catch (Exception ex) { Emit("error", "where", "comp-init", "message", ex.Message); }
            _compReady.Set();
            if (!ok) return;
            var handles = new[] { _cqEvt.SafeWaitHandle.DangerousGetHandle() };
            while (!_stop)
            {
                Win.MsgWaitForMultipleObjects(1, handles, false, 50, 0x4FF /*QS_ALLINPUT*/);
                Win.MSG m;
                while (Win.PeekMessage(out m, IntPtr.Zero, 0, 0, 1 /*PM_REMOVE*/)) { Win.TranslateMessage(ref m); Win.DispatchMessage(ref m); }
                Action a;
                while (_cq.TryTake(out a)) { try { a(); } catch (Exception ex) { Emit("error", "where", "comp-task", "message", ex.Message); } }
            }
            foreach (IntPtr h in new[] { _hostB, _hostW, _msgWnd }) if (h != IntPtr.Zero) Win.DestroyWindow(h);
        }

        /// <summary>Runs f on the compositor thread (falls back to the desk thread if it could not start).</summary>
        public T OnComp<T>(Func<T> f, int timeoutMs)
        {
            if (_compThread == null || _msgWnd == IntPtr.Zero) return OnDesk(f, timeoutMs);
            if (Thread.CurrentThread == _compThread) return f();
            T res = default(T); Exception err = null; var done = new ManualResetEvent(false);
            _cq.Add(delegate { try { res = f(); } catch (Exception e) { err = e; } finally { done.Set(); } });
            _cqEvt.Set();
            if (!done.WaitOne(timeoutMs)) throw new TimeoutException("compositor busy (" + timeoutMs + "ms)");
            if (err != null) throw new InvalidOperationException(err.Message, err);
            return res;
        }

        IntPtr CompWndProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
        {
            if (msg == Win.WM_COPYDATA && h == _msgWnd && l != IntPtr.Zero)
            {
                try { return new IntPtr(OnCopyData((Win.COPYDATASTRUCT)Marshal.PtrToStructure(l, typeof(Win.COPYDATASTRUCT)))); }
                catch (Exception ex) { Emit("error", "where", "copydata", "message", ex.Message); return new IntPtr(2); }
            }
            return Win.DefWindowProc(h, msg, w, l);
        }

        /// <summary>
        /// A request from a process on the hidden desktop (the AHK probe): UTF-16 JSON {"cmd":"shot",...,"reply":"file.json"}.
        /// Returns 1 = ok, 2 = failed; the full result (or error) is written to "reply" when given.
        /// </summary>
        int OnCopyData(Win.COPYDATASTRUCT cds)
        {
            if (cds.dwData.ToInt64() != CopyDataMagic || cds.cbData <= 0 || cds.cbData > 1 << 20) return 0;
            string json = Marshal.PtrToStringUni(cds.lpData, cds.cbData / 2).TrimEnd('\0');
            var req = J.Parse(json); string reply = J.Str(req, "reply"); string cmd = J.Str(req, "cmd", "shot");
            Dict res; int code = 1;
            try
            {
                if (cmd == "shot") { if (!J.Has(req, "tech")) req["tech"] = "composed"; if (!J.Has(req, "label")) req["label"] = "probe"; res = J.O("ok", true, "result", Shot(req)); }
                else if (cmd == "ping") res = J.O("ok", true, "result", J.O("desktop", DeskName, "screen", new object[] { ScreenW, ScreenH }));
                else throw new ArgumentException("unknown host command: " + cmd);
            }
            catch (Exception ex) { res = J.O("ok", false, "error", ex.Message); code = 2; }
            if (reply != null) { try { File.WriteAllText(reply, J.Ser(res), new UTF8Encoding(false)); } catch { } }
            return code;
        }

        // ------------------------------------------------------------------ host windows

        IntPtr MakeHostWindow(string cls, int cx, int cy)
        {
            // Cloaked + off screen + at the bottom: nothing ever shows, hit-tests or takes activation; DWM still renders it for PrintWindow.
            IntPtr h = Win.CreateWindowEx(Win.WS_EX_TOOLWINDOW | Win.WS_EX_NOACTIVATE | Win.WS_EX_TRANSPARENT, cls, "ahkh compositor", Win.WS_POPUP,
                                          -32000, -32000, cx, cy, IntPtr.Zero, IntPtr.Zero, Marshal.GetHINSTANCE(typeof(Host).Module), IntPtr.Zero);
            if (h == IntPtr.Zero) throw new InvalidOperationException("compositor window: CreateWindowEx failed " + Marshal.GetLastWin32Error());
            int one = 1; Win.DwmSetWindowAttribute(h, Win.DWMWA_CLOAK, ref one, 4);
            Win.SetWindowPos(h, Win.HWND_BOTTOM, 0, 0, 0, 0, Win.SWP_NOMOVE | Win.SWP_NOSIZE | Win.SWP_NOACTIVATE | Win.SWP_SHOWWINDOW);
            return h;
        }

        void EnsureHosts(int cx, int cy)
        {
            if (_hostB != IntPtr.Zero && cx <= _hostCx && cy <= _hostCy) return;
            cx = Math.Max(Math.Max(cx, _hostCx), Math.Max(ScreenW, 800)); cy = Math.Max(Math.Max(cy, _hostCy), Math.Max(ScreenH, 600));
            if (_hostB == IntPtr.Zero) { _hostB = MakeHostWindow("AhkhCompositorB", cx, cy); _hostW = MakeHostWindow("AhkhCompositorW", cx, cy); }
            else foreach (IntPtr h in new[] { _hostB, _hostW }) Win.SetWindowPos(h, IntPtr.Zero, 0, 0, cx, cy, Win.SWP_NOMOVE | Win.SWP_NOZORDER | Win.SWP_NOACTIVATE);
            _hostCx = cx; _hostCy = cy;
        }

        static int[] PrintHost(IntPtr host, int w, int h)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr dc = g.GetHdc();
                    try { Win.PrintWindow(host, dc, Win.PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(dc); }
                }
                return Pixels(bmp);
            }
        }

        static int[] Pixels(Bitmap bmp)
        {
            var px = new int[bmp.Width * bmp.Height];
            var bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try { for (int y = 0; y < bmp.Height; y++) Marshal.Copy(bd.Scan0 + y * bd.Stride, px, y * bmp.Width, bmp.Width); }
            finally { bmp.UnlockBits(bd); }
            return px;
        }

        static Bitmap ToBitmap(int[] px, int w, int h)
        {
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try { for (int y = 0; y < h; y++) Marshal.Copy(px, y * w, bd.Scan0 + y * bd.Stride, w); }
            finally { bmp.UnlockBits(bd); }
            return bmp;
        }

        /// <summary>Alpha from a render over black and one over white: a = 1 - (white - black); colour = black / a.</summary>
        static int[] Matte(int[] b, int[] w)
        {
            var o = new int[b.Length];
            for (int i = 0; i < b.Length; i++)
            {
                int cb = b[i], cw = w[i];
                int br = (cb >> 16) & 255, bg = (cb >> 8) & 255, bb = cb & 255;
                int d = Math.Max(((cw >> 16) & 255) - br, Math.Max(((cw >> 8) & 255) - bg, (cw & 255) - bb));
                int a = 255 - d; if (a <= 0) { o[i] = 0; continue; } if (a > 255) a = 255;
                if (a == 255) { o[i] = cb | unchecked((int)0xFF000000); continue; }
                int r = Math.Min(255, (br * 255 + a / 2) / a), g = Math.Min(255, (bg * 255 + a / 2) / a), bl = Math.Min(255, (bb * 255 + a / 2) / a);
                o[i] = (a << 24) | (r << 16) | (g << 8) | bl;
            }
            return o;
        }

        /// <summary>DWM's own rendering of one window, with exact per-pixel alpha. Null (and why) when DWM cannot give it.</summary>
        Layer ThumbLayer(IntPtr src, bool flush, out string why)
        {
            why = null;
            EnsureHosts(1, 1);
            IntPtr tb, tw;
            int hr = Win.DwmRegisterThumbnail(_hostB, src, out tb);
            if (hr != 0) { why = "DwmRegisterThumbnail 0x" + hr.ToString("X8"); return null; }
            hr = Win.DwmRegisterThumbnail(_hostW, src, out tw);
            if (hr != 0) { Win.DwmUnregisterThumbnail(tb); why = "DwmRegisterThumbnail 0x" + hr.ToString("X8"); return null; }
            try
            {
                Win.SIZE s; Win.DwmQueryThumbnailSourceSize(tb, out s);
                if (s.cx <= 0 || s.cy <= 0 || s.cx > 16000 || s.cy > 16000) { why = "thumbnail source size " + s.cx + "x" + s.cy; return null; }
                EnsureHosts(s.cx, s.cy);
                var p = new Win.DWM_THUMBNAIL_PROPERTIES { dwFlags = Win.DWM_TNP_RECTDESTINATION | Win.DWM_TNP_OPACITY | Win.DWM_TNP_VISIBLE | Win.DWM_TNP_SOURCECLIENTAREAONLY,
                                                           rcDestination = new Win.RECT { Left = 0, Top = 0, Right = s.cx, Bottom = s.cy }, opacity = 255, fVisible = 1, fSourceClientAreaOnly = 0 };
                Win.DwmUpdateThumbnailProperties(tb, ref p); Win.DwmUpdateThumbnailProperties(tw, ref p);
                if (flush) Win.DwmFlush();
                int[] b = PrintHost(_hostB, s.cx, s.cy), w = PrintHost(_hostW, s.cx, s.cy);
                return new Layer { W = s.cx, H = s.cy, Px = Matte(b, w), Method = "dwm-thumbnail" };
            }
            finally { Win.DwmUnregisterThumbnail(tb); Win.DwmUnregisterThumbnail(tw); }
        }

        // ------------------------------------------------------------------ redirection surface (D3D11, raw vtables: no SDK, no WinRT)

        IntPtr _d3dDev, _d3dCtx;
        static readonly Guid IID_Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        [StructLayout(LayoutKind.Sequential)] struct TexDesc { public uint W, H, Mips, Array, Format, SCount, SQuality, Usage, Bind, Cpu, Misc; }
        [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint Row, Depth; }
        delegate int D_CreateTex2D(IntPtr self, ref TexDesc d, IntPtr init, out IntPtr tex);
        delegate int D_OpenShared(IntPtr self, IntPtr h, ref Guid iid, out IntPtr p);
        delegate void D_GetDesc(IntPtr self, out TexDesc d);
        delegate void D_Copy(IntPtr self, IntPtr dst, IntPtr src);
        delegate int D_Map(IntPtr self, IntPtr res, uint sub, int type, uint flags, out Mapped m);
        delegate void D_Unmap(IntPtr self, IntPtr res, uint sub);
        static T VT<T>(IntPtr o, int slot) where T : class
        {
            IntPtr fn = Marshal.ReadIntPtr(Marshal.ReadIntPtr(o), slot * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(fn, typeof(T)) as T;
        }

        /// <summary>The window's redirection surface as DWM holds it (works for windows excluded from capture; not for UpdateLayeredWindow ones).</summary>
        Layer SurfaceLayer(IntPtr hwnd, out string why)
        {
            why = null;
            IntPtr hs; long luid; uint fmt, fl; ulong upd;
            if (!Win.DwmGetDxSharedSurface(hwnd, out hs, out luid, out fmt, out fl, out upd) || hs == IntPtr.Zero)
            { why = "no redirection surface (err " + Marshal.GetLastWin32Error() + ")"; return null; }
            if (fmt != 87 && fmt != 88 && fmt != 91) { why = "surface format " + fmt; return null; }   // B8G8R8A8 / B8G8R8X8 (+SRGB)
            if (_d3dDev == IntPtr.Zero)
            {
                int lvl; int hr0 = Win.D3D11CreateDevice(IntPtr.Zero, 1 /*HARDWARE*/, IntPtr.Zero, 0x20 /*BGRA_SUPPORT*/, IntPtr.Zero, 0, 7, out _d3dDev, out lvl, out _d3dCtx);
                if (hr0 < 0) { _d3dDev = IntPtr.Zero; why = "D3D11CreateDevice 0x" + hr0.ToString("X8"); return null; }
            }
            Guid iid = IID_Texture2D; IntPtr tex;
            int hr = VT<D_OpenShared>(_d3dDev, 28)(_d3dDev, hs, ref iid, out tex);
            if (hr < 0) { why = "OpenSharedResource 0x" + hr.ToString("X8"); return null; }
            IntPtr st = IntPtr.Zero;
            try
            {
                TexDesc d; VT<D_GetDesc>(tex, 10)(tex, out d);
                var sd = d; sd.Usage = 3 /*STAGING*/; sd.Bind = 0; sd.Cpu = 0x20000 /*READ*/; sd.Misc = 0; sd.Mips = 1; sd.Array = 1; sd.SCount = 1; sd.SQuality = 0;
                hr = VT<D_CreateTex2D>(_d3dDev, 5)(_d3dDev, ref sd, IntPtr.Zero, out st);
                if (hr < 0) { why = "CreateTexture2D 0x" + hr.ToString("X8"); return null; }
                VT<D_Copy>(_d3dCtx, 47)(_d3dCtx, st, tex);
                Mapped m; hr = VT<D_Map>(_d3dCtx, 14)(_d3dCtx, st, 0, 1 /*READ*/, 0, out m);
                if (hr < 0) { why = "Map 0x" + hr.ToString("X8"); return null; }
                int w = (int)d.W, h = (int)d.H; var px = new int[w * h];
                try { for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(m.Data.ToInt64() + (long)y * m.Row), px, y * w, w); }
                finally { VT<D_Unmap>(_d3dCtx, 15)(_d3dCtx, st, 0); }
                return new Layer { W = w, H = h, Px = px, Method = "redirection-surface" };
            }
            finally { if (st != IntPtr.Zero) Marshal.Release(st); Marshal.Release(tex); }
        }

        // ------------------------------------------------------------------ per window

        static Win.RECT FrameBounds(IntPtr h)
        {
            Win.RECT r, e; Win.GetWindowRect(h, out r);
            if (Win.DwmGetWindowAttribute(h, Win.DWMWA_EXTENDED_FRAME_BOUNDS, out e, Marshal.SizeOf(typeof(Win.RECT))) == 0 && e.Right > e.Left && e.Bottom > e.Top) return e;
            return r;
        }

        static bool IsCloaked(IntPtr h) { int v; return Win.DwmGetWindowAttribute(h, Win.DWMWA_CLOAKED, out v, 4) == 0 && v != 0; }

        /// <summary>Best available rendering of one top-level window, positioned in screen coordinates. Null + why if unreadable.</summary>
        Layer WindowLayer(IntPtr h, bool flush, out string why)
        {
            why = null;
            long ex = Win.GetLong(h, Win.GWL_EXSTYLE);
            uint aff = 0; Win.GetWindowDisplayAffinity(h, out aff);
            uint key = 0, lwaFlags = 0; byte alpha = 255;
            bool lwa = (ex & Win.WS_EX_LAYERED) != 0 && Win.GetLayeredWindowAttributes(h, out key, out alpha, out lwaFlags);
            Win.RECT fb = FrameBounds(h);
            Layer L = null; string why1 = null, why2 = null;
            if (aff == 0) L = ThumbLayer(h, flush, out why1);
            else why1 = "excluded from capture (display affinity 0x" + aff.ToString("X") + ")";
            if (L == null)
            {
                L = SurfaceLayer(h, out why2);
                if (L != null)
                {
                    // the surface covers the whole window rect (invisible resize borders included): crop to the frame bounds, GDI alpha is meaningless
                    Win.RECT wr; Win.GetWindowRect(h, out wr);
                    L = Crop(L, fb.Left - wr.Left, fb.Top - wr.Top, fb.Right - fb.Left, fb.Bottom - fb.Top);
                    for (int i = 0; i < L.Px.Length; i++) L.Px[i] |= unchecked((int)0xFF000000);
                    L.Method = "redirection-surface"; L.Note = why1;
                }
            }
            if (L == null) { why = why1 + "; " + why2; return null; }
            if (lwa)
            {
                // DWM thumbnails ignore SetLayeredWindowAttributes: apply the colour key and constant alpha the screen would.
                int keyRgb = (int)(((key & 0xFF) << 16) | (key & 0xFF00) | ((key >> 16) & 0xFF));
                for (int i = 0; i < L.Px.Length; i++)
                {
                    int c = L.Px[i];
                    if ((lwaFlags & Win.LWA_COLORKEY) != 0 && (c & 0xFFFFFF) == keyRgb) { L.Px[i] = 0; continue; }
                    if ((lwaFlags & Win.LWA_ALPHA) != 0) { int a = ((c >> 24) & 255) * alpha / 255; L.Px[i] = (a << 24) | (c & 0xFFFFFF); }
                }
                L.Note = (L.Note == null ? "" : L.Note + "; ") + "layered attributes applied (alpha " + alpha + ((lwaFlags & Win.LWA_COLORKEY) != 0 ? ", colour key" : "") + ")";
            }
            L.X = fb.Left; L.Y = fb.Top;
            return L;
        }

        static Layer Crop(Layer s, int x, int y, int w, int h)
        {
            x = Math.Max(0, x); y = Math.Max(0, y); w = Math.Min(w, s.W - x); h = Math.Min(h, s.H - y);
            if (w <= 0 || h <= 0 || (x == 0 && y == 0 && w == s.W && h == s.H)) return s;
            var px = new int[w * h];
            for (int r = 0; r < h; r++) Array.Copy(s.Px, (y + r) * s.W + x, px, r * w, w);
            return new Layer { X = s.X + x, Y = s.Y + y, W = w, H = h, Px = px, Method = s.Method, Note = s.Note };
        }

        /// <summary>Straight-alpha "over": layer onto canvas (cw x ch), canvas origin (ox, oy) in screen coordinates.</summary>
        static void Over(int[] dst, int cw, int ch, int ox, int oy, Layer L)
        {
            int x0 = Math.Max(0, L.X - ox), y0 = Math.Max(0, L.Y - oy), x1 = Math.Min(cw, L.X - ox + L.W), y1 = Math.Min(ch, L.Y - oy + L.H);
            for (int y = y0; y < y1; y++)
            {
                int si = (y + oy - L.Y) * L.W + (x0 + ox - L.X), di = y * cw + x0;
                for (int x = x0; x < x1; x++, si++, di++)
                {
                    int s = L.Px[si]; int sa = (s >> 24) & 255;
                    if (sa == 0) continue;
                    if (sa == 255) { dst[di] = s; continue; }
                    int d = dst[di]; int da = (d >> 24) & 255;
                    int dw = da * (255 - sa) / 255; int oa = sa + dw; if (oa == 0) { dst[di] = 0; continue; }
                    int r = (((s >> 16) & 255) * sa + ((d >> 16) & 255) * dw) / oa;
                    int g = (((s >> 8) & 255) * sa + ((d >> 8) & 255) * dw) / oa;
                    int b = ((s & 255) * sa + (d & 255) * dw) / oa;
                    dst[di] = (oa << 24) | (r << 16) | (g << 8) | b;
                }
            }
        }

        static void Hatch(int[] dst, int cw, int ch, int ox, int oy, Win.RECT r)
        {
            for (int y = Math.Max(0, r.Top - oy); y < Math.Min(ch, r.Bottom - oy); y++)
                for (int x = Math.Max(0, r.Left - ox); x < Math.Min(cw, r.Right - ox); x++)
                {
                    bool edge = x + ox == r.Left || x + ox == r.Right - 1 || y + oy == r.Top || y + oy == r.Bottom - 1;
                    if (edge || ((x + y) & 15) < 2) dst[y * cw + x] = unchecked((int)0xFFFF00FF);
                }
        }

        // ------------------------------------------------------------------ background

        int[] Background(string bg, int w, int h)
        {
            var px = new int[w * h];
            bg = (bg ?? "wallpaper").ToLowerInvariant();
            if (bg == "transparent" || bg == "none") return px;
            if (bg == "checker")
            {
                for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) px[y * w + x] = ((x >> 3) + (y >> 3)) % 2 == 0 ? unchecked((int)0xFFCCCCCC) : unchecked((int)0xFFFFFFFF);
                return px;
            }
            if (bg.StartsWith("#") && bg.Length == 7)
            {
                int c = Convert.ToInt32(bg.Substring(1), 16) | unchecked((int)0xFF000000);
                for (int i = 0; i < px.Length; i++) px[i] = c;
                return px;
            }
            uint sys = Win.GetSysColor(1 /*COLOR_DESKTOP*/);
            int solid = unchecked((int)0xFF000000) | (int)(((sys & 0xFF) << 16) | (sys & 0xFF00) | ((sys >> 16) & 0xFF));
            if (bg == "wallpaper")
            {
                try
                {
                    var sb = new StringBuilder(520);
                    if (Win.SystemParametersInfo(0x73 /*SPI_GETDESKWALLPAPER*/, (uint)sb.Capacity, sb, 0) && sb.Length > 0 && File.Exists(sb.ToString()))
                        using (var img = Image.FromFile(sb.ToString()))
                        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                        {
                            using (var g = Graphics.FromImage(bmp))
                            {
                                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                double s = Math.Max((double)w / img.Width, (double)h / img.Height);   // "fill"
                                int dw = (int)Math.Ceiling(img.Width * s), dh = (int)Math.Ceiling(img.Height * s);
                                g.DrawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
                            }
                            return Pixels(bmp);
                        }
                }
                catch { }
            }
            for (int i = 0; i < px.Length; i++) px[i] = solid;
            return px;
        }

        // ------------------------------------------------------------------ composition

        internal sealed class Composed { public Bitmap Bmp; public List<object> Layers = new List<object>(); public List<object> Unreadable = new List<object>(); public long Ms; }

        /// <summary>
        /// The hidden desktop as the screen would show it (rect in screen coordinates; null = whole screen). only != 0: just that window
        /// (over the background, no other windows).
        /// </summary>
        public Composed Compose(Win.RECT? area, IntPtr only, string bg, bool flush)
        {
            return OnComp(delegate
            {
                var sw = Stopwatch.StartNew();
                Win.RECT a = area.HasValue ? area.Value : new Win.RECT { Left = 0, Top = 0, Right = Math.Max(1, ScreenW), Bottom = Math.Max(1, ScreenH) };
                int cw = Math.Max(1, a.Right - a.Left), ch = Math.Max(1, a.Bottom - a.Top);
                var res = new Composed();
                int[] canvas = Background(bg, cw, ch);
                var tops = new List<IntPtr>();
                if (only != IntPtr.Zero) tops.Add(only);
                else
                {
                    Win.EnumDesktopWindows(Desk, delegate (IntPtr x, IntPtr l) { tops.Add(x); return true; }, IntPtr.Zero);
                    tops.Reverse();   // bottom of the z-order first
                }
                foreach (IntPtr h in tops)
                {
                    if (!Win.IsWindowVisible(h) || Win.IsIconic(h) || IsOwnWindow(h) || IsCloaked(h)) continue;
                    Win.RECT fb = FrameBounds(h);
                    if (fb.Right <= a.Left || fb.Left >= a.Right || fb.Bottom <= a.Top || fb.Top >= a.Bottom) continue;
                    var t = Stopwatch.StartNew(); string why;
                    Layer L = null;
                    try { L = WindowLayer(h, flush, out why); } catch (Exception ex) { why = ex.Message; }
                    var info = J.O("hwnd", Hx(h), "class", Win.GetClass(h), "pid", Win.Pid(h), "rect", Rc(fb));
                    if (L == null)
                    {
                        Hatch(canvas, cw, ch, a.Left, a.Top, fb);
                        info["why"] = why; res.Unreadable.Add(info); continue;
                    }
                    Over(canvas, cw, ch, a.Left, a.Top, L);
                    info["method"] = L.Method; info["ms"] = t.ElapsedMilliseconds; if (L.Note != null) info["note"] = L.Note;
                    res.Layers.Add(info);
                }
                res.Bmp = ToBitmap(canvas, cw, ch);
                res.Ms = sw.ElapsedMilliseconds;
                return res;
            }, 60000);
        }
    }
}
