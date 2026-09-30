using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Ahkh
{
    /// <summary>All Win32 interop used by the host. One place, so the rest of the code stays readable.</summary>
    internal static class Win
    {
        public const uint GENERIC_ALL = 0x10000000, GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
        public const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
        public const uint CREATE_ALWAYS = 2, OPEN_EXISTING = 3, OPEN_ALWAYS = 4;
        public const uint FILE_ATTRIBUTE_NORMAL = 0x80;
        public const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
        public const int STARTF_USESHOWWINDOW = 0x1, STARTF_USESTDHANDLES = 0x100;
        public const short SW_HIDE = 0, SW_SHOWNORMAL = 1, SW_SHOWMINIMIZED = 2, SW_SHOWMAXIMIZED = 3, SW_SHOWNOACTIVATE = 4, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
        public const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102;

        public const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        public const int JobObjectBasicProcessIdList = 3, JobObjectBasicUIRestrictions = 4, JobObjectExtendedLimitInformation = 9;
        public const uint UILIMIT_READCLIPBOARD = 0x2, UILIMIT_WRITECLIPBOARD = 0x4, UILIMIT_SYSTEMPARAMETERS = 0x8, UILIMIT_DISPLAYSETTINGS = 0x10, UILIMIT_DESKTOP = 0x40, UILIMIT_EXITWINDOWS = 0x80;
        public const uint SEM_FAILCRITICALERRORS = 0x1, SEM_NOGPFAULTERRORBOX = 0x2, SEM_NOOPENFILEERRORBOX = 0x8000;

        public const int WM_NULL = 0, WM_SETTEXT = 0xC, WM_GETTEXT = 0xD, WM_GETTEXTLENGTH = 0xE, WM_CLOSE = 0x10, WM_ACTIVATE = 0x6, WM_SETFOCUS = 0x7,
            WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105, WM_COMMAND = 0x111, WM_SYSCOMMAND = 0x112,
            WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_LBUTTONDBLCLK = 0x203, WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205,
            WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208, WM_MOUSEWHEEL = 0x20A, WM_MOUSEACTIVATE = 0x21, WM_NCHITTEST = 0x84, WM_SETCURSOR = 0x20;
        public const int DM_GETDEFID = 0x400;
        public const int BM_GETCHECK = 0xF0, BM_SETCHECK = 0xF1, BM_CLICK = 0xF5;
        public const int EM_SETSEL = 0xB1, EM_REPLACESEL = 0xC2, EM_GETLINECOUNT = 0xBA;
        public const int CB_GETCOUNT = 0x146, CB_GETCURSEL = 0x147, CB_GETLBTEXT = 0x148, CB_GETLBTEXTLEN = 0x149, CB_SETCURSEL = 0x14E, CB_FINDSTRINGEXACT = 0x158;
        public const int LB_GETCOUNT = 0x18B, LB_GETCURSEL = 0x188, LB_GETTEXT = 0x189, LB_GETTEXTLEN = 0x18A, LB_SETCURSEL = 0x186, LB_FINDSTRINGEXACT = 0x1A2;
        public const int TCM_GETITEMCOUNT = 0x1304, TCM_GETCURSEL = 0x130B, TCM_SETCURSEL = 0x130C;
        public const int SC_CLOSE = 0xF060, SC_MINIMIZE = 0xF020, SC_MAXIMIZE = 0xF030, SC_RESTORE = 0xF120;
        public const uint SMTO_ABORTIFHUNG = 0x2, SMTO_BLOCK = 0x1;
        public const uint PW_CLIENTONLY = 0x1, PW_RENDERFULLCONTENT = 0x2;
        public const int GWL_ID = -12, GWL_STYLE = -16, GWL_EXSTYLE = -20;
        public const uint CWP_SKIPINVISIBLE = 1, CWP_SKIPDISABLED = 2, CWP_SKIPTRANSPARENT = 4;
        public const uint GW_OWNER = 4;
        public const int MK_LBUTTON = 1, MK_RBUTTON = 2;
        public const uint SRCCOPY = 0x00CC0020;
        public const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10;
        public const int DESKTOPENUM = 1;
        public const uint WINSTA_ALL_ACCESS = 0x37F;

        public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb; public string lpReserved, lpDesktop, lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
        public delegate bool EnumDesktopProc(string name, IntPtr lParam);

        // --- desktops / stations
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr h);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateWindowStation(string name, uint flags, uint access, IntPtr sa);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessWindowStation(IntPtr h);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseWindowStation(IntPtr h);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int len, out int needed);
        [StructLayout(LayoutKind.Sequential)] public struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public int dwFlags; }
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetUserObjectInformation(IntPtr h, int index, ref USEROBJECTFLAGS info, int len);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool GetUserObjectInformation(IntPtr h, int index, ref USEROBJECTFLAGS info, int len, out int needed);
        public const int UOI_FLAGS = 1, WSF_VISIBLE = 1;
        /// <summary>Name of a window station / desktop handle (UOI_NAME = 2).</summary>
        public static string ObjectName(IntPtr h) { var sb = new StringBuilder(260); int n; return GetUserObjectInformation(h, 2, sb, sb.Capacity * 2, out n) ? sb.ToString() : null; }
        [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDesktops(IntPtr hwinsta, EnumDesktopProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int threadId);
        [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();

        // --- windows
        [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr h, int i);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);
        public static long GetLong(IntPtr h, int i) { return IntPtr.Size == 8 ? GetWindowLongPtr64(h, i).ToInt64() : GetWindowLong32(h, i); }
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
        [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT pt, uint flags);
        [DllImport("user32.dll")] public static extern int MapWindowPoints(IntPtr from, IntPtr to, ref POINT p, int count);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr hProcess, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeoutI(IntPtr h, int msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

        // --- jobs / processes
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr sa, string name);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint size, out uint ret);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsWow64Process(IntPtr h, out bool wow64);

        public static void TerminateOwn(IntPtr hProcess) { try { TerminateProcess(hProcess, 1); } catch { } }

        public static string GetClass(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }

        /// <summary>WM_GETTEXT with a timeout so a hung target never blocks us.</summary>
        public static string GetText(IntPtr h)
        {
            IntPtr len;
            if (SendMessageTimeoutI(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, 400, out len) == IntPtr.Zero) return "";
            int n = (int)len; if (n <= 0) return ""; if (n > 262144) n = 262144;
            var sb = new StringBuilder(n + 2); IntPtr ig;
            SendMessageTimeout(h, WM_GETTEXT, new IntPtr(sb.Capacity), sb, SMTO_ABORTIFHUNG | SMTO_BLOCK, 400, out ig);
            return sb.ToString();
        }

        public static bool IsResponsive(IntPtr h, uint ms) { IntPtr r; return SendMessageTimeoutI(h, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG | SMTO_BLOCK, ms, out r) != IntPtr.Zero; }

        /// <summary>SendMessage with a timeout; returns false if the target did not answer.</summary>
        public static bool Send(IntPtr h, int msg, long w, long l, out long result, uint ms)
        {
            IntPtr r; bool ok = SendMessageTimeoutI(h, msg, new IntPtr(w), new IntPtr(l), SMTO_ABORTIFHUNG, ms, out r) != IntPtr.Zero;
            result = ok ? r.ToInt64() : 0; return ok;
        }

        public static int Pid(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }
        public static long Hex(IntPtr h) { return h.ToInt64(); }
        public static int Id(IntPtr h) { return (int)(GetLong(h, GWL_ID) & 0xFFFF); }
        public static IntPtr MakeLParam(int lo, int hi) { return new IntPtr((hi << 16) | (lo & 0xFFFF)); }
    }
}
