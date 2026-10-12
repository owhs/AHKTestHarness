using System;
using System.Collections.Generic;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>
    /// A synthetic mouse for the hidden desktop: the screen point is routed the way real input would be, by the desktop's own
    /// hit-testing (WindowFromPoint on a thread attached to it: hidden / disabled windows, WS_EX_TRANSPARENT layered windows and the
    /// alpha-0 pixels of UpdateLayeredWindow windows are passed through), then WM_NCHITTEST (HTTRANSPARENT walks on to the window
    /// below), WM_SETCURSOR, WM_(NC)MOUSEMOVE, WM_MOUSELEAVE to the window it left, buttons and wheel - all posted, never SendInput.
    ///
    /// The cursor position lives in a small shared memory block ("AHKH_CURSOR_MAP" in the targets' environment): GetCursorPos fails
    /// on a non-input desktop (measured: returns FALSE, MouseGetPos gives garbage), so the AHK probe points the script's
    /// GetCursorPos at this block - hover logic, ToolTip placement and MouseGetPos then see the synthetic cursor.
    /// What cannot be simulated: low-level hooks (WH_MOUSE_LL / WH_KEYBOARD_LL only see real input on the input desktop),
    /// GetAsyncKeyState / GetKeyState of buttons, raw input, and DefWindowProc's modal move/size loops (they wait for real button-up).
    /// </summary>
    internal sealed partial class Host
    {
        Win.POINT _cursor; IntPtr _hover; long _hoverHt;
        MemoryMappedFile _curMap; MemoryMappedViewAccessor _curView; int _curSeq;
        public string CursorMapName;

        void StartCursorMap()
        {
            try
            {
                CursorMapName = "ahkh-cursor-" + DeskName;
                _curMap = MemoryMappedFile.CreateNew(CursorMapName, 64);
                _curView = _curMap.CreateViewAccessor(0, 64);
                _cursor = new Win.POINT { X = Math.Max(1, ScreenW) / 2, Y = Math.Max(1, ScreenH) / 2 };
                WriteCursor();
            }
            catch (Exception ex) { CursorMapName = null; Emit("error", "where", "cursor-map", "message", ex.Message); }
        }

        /// <summary>Layout: int x, int y, int seq, int buttons (bit 0 left, 1 right, 2 middle).</summary>
        void WriteCursor(int buttons = 0)
        {
            if (_curView == null) return;
            _curView.Write(0, _cursor.X); _curView.Write(4, _cursor.Y); _curView.Write(12, buttons); _curView.Write(8, ++_curSeq);
        }

        const int HTTRANSPARENT = -1, HTNOWHERE = 0, HTCLIENT = 1, HTCAPTION = 2, HTSYSMENU = 3, HTMINBUTTON = 8, HTMAXBUTTON = 9, HTCLOSE = 20, HTHELP = 21;
        static string HtName(long ht)
        {
            switch ((int)ht)
            {
                case -2: return "error"; case -1: return "transparent"; case 0: return "nowhere"; case 1: return "client"; case 2: return "caption";
                case 3: return "sysmenu"; case 4: return "growbox"; case 5: return "menu"; case 6: return "hscroll"; case 7: return "vscroll";
                case 8: return "minbutton"; case 9: return "maxbutton"; case 10: return "left"; case 11: return "right"; case 12: return "top";
                case 13: return "topleft"; case 14: return "topright"; case 15: return "bottom"; case 16: return "bottomleft"; case 17: return "bottomright";
                case 18: return "border"; case 20: return "close"; case 21: return "help";
            }
            return ht.ToString();
        }

        /// <summary>The next window under the point below 'h' among its siblings (for HTTRANSPARENT), descending into children.</summary>
        static IntPtr NextBelow(IntPtr h, Win.POINT pt)
        {
            for (IntPtr w = Win.GetWindow(h, 2 /*GW_HWNDNEXT*/); w != IntPtr.Zero; w = Win.GetWindow(w, 2))
            {
                if (!Win.IsWindowVisible(w) || !Win.IsWindowEnabled(w) || IsOwnWindow(w)) continue;
                Win.RECT r; Win.GetWindowRect(w, out r);
                if (pt.X < r.Left || pt.X >= r.Right || pt.Y < r.Top || pt.Y >= r.Bottom) continue;
                long ex = Win.GetLong(w, Win.GWL_EXSTYLE);
                if ((ex & Win.WS_EX_LAYERED) != 0 && (ex & Win.WS_EX_TRANSPARENT) != 0) continue;
                return DeepChildAt(w, pt.X, pt.Y);
            }
            IntPtr parent = Win.GetParent(h);
            return parent != IntPtr.Zero && (Win.GetLong(h, Win.GWL_STYLE) & 0x40000000) != 0 ? NextBelow(parent, pt) : IntPtr.Zero;
        }

        /// <summary>Topmost visible top-level window whose rectangle holds the point (what a naive, rectangle-only router would pick).</summary>
        IntPtr RectTop(Win.POINT pt)
        {
            IntPtr found = IntPtr.Zero;
            Win.EnumDesktopWindows(Desk, delegate (IntPtr h, IntPtr l)
            {
                if (!Win.IsWindowVisible(h) || IsOwnWindow(h)) return true;
                Win.RECT r; Win.GetWindowRect(h, out r);
                if (pt.X >= r.Left && pt.X < r.Right && pt.Y >= r.Top && pt.Y < r.Bottom) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public Dict Mouse(Dict a)
        {
            return OnDesk(delegate
            {
                string act = J.Str(a, "action", "move"); string btn = J.Str(a, "button", "left");
                var pt = new Win.POINT { X = J.Int(a, "x", _cursor.X), Y = J.Int(a, "y", _cursor.Y) };
                var skipped = new List<object>();
                IntPtr hit = Win.WindowFromPoint(pt);
                long ht = HTNOWHERE;
                for (int i = 0; hit != IntPtr.Zero && i < 16; i++)
                {
                    if (!Win.Send(hit, Win.WM_NCHITTEST, 0, Win.MakeLParam(pt.X, pt.Y).ToInt64(), out ht, 300)) { ht = HTCLIENT; break; }
                    ht = (short)ht;
                    if (ht != HTTRANSPARENT) break;
                    skipped.Add(J.O("hwnd", Hx(hit), "class", Win.GetClass(hit), "why", "HTTRANSPARENT"));
                    hit = NextBelow(hit, pt);
                }
                IntPtr rectTop = RectTop(pt);
                IntPtr top = hit != IntPtr.Zero ? Win.GetAncestor(hit, 2 /*GA_ROOT*/) : IntPtr.Zero;
                // leaving the previous window
                if (_hover != IntPtr.Zero && _hover != hit && Win.IsWindow(_hover))
                    Win.PostMessage(_hover, _hoverHt == HTCLIENT ? Win.WM_MOUSELEAVE : 0x2A2 /*WM_NCMOUSELEAVE*/, IntPtr.Zero, IntPtr.Zero);
                _cursor = pt; _hover = hit; _hoverHt = ht;
                int buttons = 0;
                var res = J.O("x", pt.X, "y", pt.Y, "action", act, "hit", Hx(hit), "class", hit != IntPtr.Zero ? Win.GetClass(hit) : null,
                              "top", Hx(top), "topClass", top != IntPtr.Zero ? Win.GetClass(top) : null, "topTitle", top != IntPtr.Zero ? Win.GetText(top) : null,
                              "hitTest", HtName(ht), "rectTop", Hx(rectTop));
                if (rectTop != IntPtr.Zero && rectTop != top) res["passedThrough"] = J.O("hwnd", Hx(rectTop), "class", Win.GetClass(rectTop), "title", Win.GetText(rectTop));
                if (skipped.Count > 0) res["skipped"] = skipped;
                if (hit == IntPtr.Zero) { WriteCursor(); return res; }
                var cp = pt; Win.ScreenToClient(hit, ref cp);
                IntPtr lpc = Win.MakeLParam(cp.X, cp.Y), lps = Win.MakeLParam(pt.X, pt.Y);
                bool client = ht == HTCLIENT;
                res["clientX"] = cp.X; res["clientY"] = cp.Y;
                int downMsg = btn == "right" ? Win.WM_RBUTTONDOWN : btn == "middle" ? Win.WM_MBUTTONDOWN : Win.WM_LBUTTONDOWN;
                int upMsg = btn == "right" ? Win.WM_RBUTTONUP : btn == "middle" ? Win.WM_MBUTTONUP : Win.WM_LBUTTONUP;
                int mk = btn == "right" ? Win.MK_RBUTTON : btn == "middle" ? 0x10 : Win.MK_LBUTTON;
                Win.PostMessage(hit, Win.WM_SETCURSOR, hit, Win.MakeLParam((int)ht, act == "move" || act == "wheel" ? Win.WM_MOUSEMOVE : downMsg));
                if (client) Win.PostMessage(hit, Win.WM_MOUSEMOVE, new IntPtr(act == "up" ? mk : 0), lpc);
                else Win.PostMessage(hit, Win.WM_NCMOUSEMOVE, new IntPtr(ht), lps);
                bool down = act == "click" || act == "down" || act == "double", up = act == "click" || act == "up" || act == "double";
                if (act == "wheel")
                {
                    int delta = J.Int(a, "delta", -120);
                    Win.PostMessage(hit, Win.WM_MOUSEWHEEL, new IntPtr((delta & 0xFFFF) << 16), lps);
                }
                else if (down || up)
                {
                    if (client)
                    {
                        if (down) { Win.PostMessage(hit, downMsg, new IntPtr(mk), lpc); buttons = btn == "right" ? 2 : btn == "middle" ? 4 : 1; }
                        if (up) { Win.PostMessage(hit, upMsg, IntPtr.Zero, lpc); buttons = 0; }
                        if (act == "double") { Win.PostMessage(hit, btn == "right" ? 0x206 : btn == "middle" ? 0x209 : Win.WM_LBUTTONDBLCLK, new IntPtr(mk), lpc); Win.PostMessage(hit, upMsg, IntPtr.Zero, lpc); }
                        res["sent"] = act;
                    }
                    else
                    {
                        // Non-client: DefWindowProc answers a button-down on the caption, borders or caption buttons with a modal tracking
                        // loop that only ends on real input. Do what the click would have done instead.
                        int sc = ht == HTCLOSE ? Win.SC_CLOSE : ht == HTMINBUTTON ? Win.SC_MINIMIZE : ht == HTMAXBUTTON ? (Win.IsZoomed(top) ? Win.SC_RESTORE : Win.SC_MAXIMIZE) : 0;
                        if (sc != 0 && up && btn == "left") { Win.PostMessage(top, Win.WM_SYSCOMMAND, new IntPtr(sc), lps); res["sent"] = "WM_SYSCOMMAND " + HtName(ht); }
                        else if (btn == "right" && up && (ht == HTCAPTION || ht == HTSYSMENU)) { Win.PostMessage(top, 0x7B /*WM_CONTEXTMENU*/, top, lps); res["sent"] = "WM_CONTEXTMENU"; }
                        else res["note"] = "non-client " + HtName(ht) + ": not pressed (DefWindowProc would start a modal move/size loop that only real input ends); use window move/maximize";
                    }
                }
                WriteCursor(buttons);
                return res;
            });
        }
    }
}
