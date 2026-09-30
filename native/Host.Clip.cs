using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>
    /// Clipboard guardian for the USER'S session. The job's UI limit stops sandboxed processes from WRITING clipboard data but not from
    /// EMPTYING it (the selftest caught that), so scripts that touch A_Clipboard would silently wipe what the user had copied.
    /// This keeps a live snapshot of the user's clipboard (text, file lists, images, HTML/RTF/PNG) and puts it back within milliseconds
    /// whenever one of OUR processes empties it. It never restores over something the user copied themselves.
    /// </summary>
    internal sealed partial class Host
    {
        sealed class ClipFormat { public uint Id; public byte[] Data; }

        [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("user32.dll")] static extern bool EmptyClipboard();
        [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint fmt);
        [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint fmt);
        [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
        [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
        [DllImport("user32.dll")] static extern int CountClipboardFormats();
        [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr h);
        delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WNDCLASSEX { public uint cbSize, style; public IntPtr lpfnWndProc; public int cbClsExtra, cbWndExtra; public IntPtr hInstance, hIcon, hCursor, hbrBackground; public string lpszMenuName, lpszClassName; public IntPtr hIconSm; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassEx(ref WNDCLASSEX c);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
        [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatName(uint fmt, StringBuilder sb, int max);

        const int WM_CLIPBOARDUPDATE = 0x031D; const uint WM_QUIT_ = 0x12;
        static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        Thread _clipThread; IntPtr _clipWnd; WndProcDelegate _clipProc;
        List<ClipFormat> _clipSnap = new List<ClipFormat>();
        long _clipRestores, _clipRestoreFails, _ignoreUpdates;
        public bool RestoreClipboard = true;
        string _clipNote;

        void StartClipGuard()
        {
            var ready = new ManualResetEvent(false);
            _clipThread = new Thread(delegate ()
            {
                try
                {
                    _clipProc = ClipWndProc;
                    var wc = new WNDCLASSEX { cbSize = (uint)Marshal.SizeOf(typeof(WNDCLASSEX)), lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_clipProc), hInstance = GetModuleHandle(null), lpszClassName = "AhkhClipGuard" };
                    RegisterClassEx(ref wc);
                    _clipWnd = CreateWindowEx(0, "AhkhClipGuard", "ahkh clipboard guard", 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
                    if (_clipWnd == IntPtr.Zero) { _clipNote = "clip window failed: " + Marshal.GetLastWin32Error(); ready.Set(); return; }
                    AddClipboardFormatListener(_clipWnd);
                    Snapshot();
                    ready.Set();
                    MSG m;
                    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
                }
                catch (Exception ex) { _clipNote = ex.Message; ready.Set(); }
            });
            _clipThread.IsBackground = true; _clipThread.SetApartmentState(ApartmentState.STA); _clipThread.Name = "clip"; _clipThread.Start();
            ready.WaitOne(3000);
        }

        bool TryOpen()
        {
            for (int i = 0; i < 15; i++) { if (OpenClipboard(_clipWnd)) return true; Thread.Sleep(8); }
            return false;
        }

        IntPtr ClipWndProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l)
        {
            if (msg == WM_CLIPBOARDUPDATE)
            {
                try { OnClipboardUpdate(); } catch (Exception ex) { _clipNote = ex.Message; }
                return IntPtr.Zero;
            }
            return DefWindowProc(hwnd, msg, w, l);
        }

        void OnClipboardUpdate()
        {
            if (Interlocked.Read(ref _ignoreUpdates) > 0) { Interlocked.Decrement(ref _ignoreUpdates); return; }   // our own restore
            IntPtr owner = Win.GetClipboardOwner();
            HashSet<int> ours = AllOurPids();
            bool ourProcess = owner != IntPtr.Zero && ours.Contains(Win.Pid(owner));
            bool emptiedNoOwner = owner == IntPtr.Zero && ours.Count > 0 && CountClipboardFormats() == 0 && _clipSnap.Count > 0;
            if ((ourProcess || emptiedNoOwner) && ours.Count > 0)
            {
                bool restored = false;
                if (RestoreClipboard && _clipSnap.Count > 0) restored = RestoreSnapshot();
                _clipChangesByUs++;
                Violation("clip:" + Now, "clipboard-touched", "restored", restored, "owner", Hx(owner), "note", restored ? "the user's clipboard was put back" : "could not restore");
                return;
            }
            Snapshot();     // the user (or another app) changed it: remember the new content
        }

        void Snapshot()
        {
            if (!TryOpen()) return;
            var list = new List<ClipFormat>(); long total = 0;
            try
            {
                uint fmt = 0;
                while ((fmt = EnumClipboardFormats(fmt)) != 0)
                {
                    if (!Snapshottable(fmt)) continue;
                    IntPtr h = GetClipboardData(fmt); if (h == IntPtr.Zero) continue;
                    long size = (long)GlobalSize(h).ToUInt64(); if (size <= 0 || size > 64L * 1024 * 1024 || total + size > 128L * 1024 * 1024) continue;
                    IntPtr p = GlobalLock(h); if (p == IntPtr.Zero) continue;
                    try { var data = new byte[size]; Marshal.Copy(p, data, 0, (int)size); list.Add(new ClipFormat { Id = fmt, Data = data }); total += size; }
                    finally { GlobalUnlock(h); }
                }
            }
            finally { CloseClipboard(); }
            if (list.Count > 0) _clipSnap = list;       // an EMPTY clipboard never replaces a good snapshot (that is exactly the wipe we undo)
        }

        static bool Snapshottable(uint fmt)
        {
            if (fmt == 1 || fmt == 7 || fmt == 8 || fmt == 13 || fmt == 15 || fmt == 16 || fmt == 17) return true;   // TEXT OEMTEXT DIB UNICODETEXT HDROP LOCALE DIBV5
            if (fmt >= 0xC000 && fmt <= 0xFFFF)   // registered formats: HTML, RTF, PNG, ... (skip huge/odd ones by name)
            {
                var sb = new StringBuilder(80); GetClipboardFormatName(fmt, sb, sb.Capacity); string n = sb.ToString();
                return n == "HTML Format" || n == "Rich Text Format" || n == "PNG" || n == "FileName" || n == "FileNameW" || n == "Preferred DropEffect" || n == "CSV" || n == "UniformResourceLocatorW" || n == "UniformResourceLocator";
            }
            return false;
        }

        bool RestoreSnapshot()
        {
            if (!TryOpen()) { _clipRestoreFails++; return false; }
            bool ok = true;
            try
            {
                Interlocked.Add(ref _ignoreUpdates, 1);
                EmptyClipboard();
                foreach (var f in _clipSnap)
                {
                    IntPtr h = GlobalAlloc(0x0002 | 0x2000, new UIntPtr((uint)f.Data.Length));   // GMEM_MOVEABLE | GMEM_DDESHARE
                    if (h == IntPtr.Zero) { ok = false; continue; }
                    IntPtr p = GlobalLock(h); Marshal.Copy(f.Data, 0, p, f.Data.Length); GlobalUnlock(h);
                    if (SetClipboardData(f.Id, h) == IntPtr.Zero) { GlobalFree(h); ok = false; }
                }
            }
            finally { CloseClipboard(); }
            if (ok) _clipRestores++; else _clipRestoreFails++;
            return ok;
        }

        Dict ClipStatus()
        {
            return J.O("snapshotFormats", _clipSnap.Count, "restores", _clipRestores, "restoreFailures", _clipRestoreFails, "note", _clipNote);
        }
    }
}
