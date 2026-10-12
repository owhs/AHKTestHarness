using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>
    /// Keeps consoles off the user's desktop.
    ///
    /// Windows 11 "default terminal" delegation: when a NEW console is created (a console program started by a GUI process such as
    /// AutoHotkey, or with CREATE_NEW_CONSOLE / ShellExecute), the inbox conhost.exe asks the registered terminal (Windows Terminal)
    /// to take it over via an out-of-process COM call. Windows Terminal runs in the user's session, outside our job, and opens the
    /// window on the user's desktop. conhost skips the handoff only when (IoDispatchers.cpp _shouldAttemptHandoff): the console is
    /// inherited, CREATE_NO_WINDOW, STARTF_USESHOWWINDOW with a hide/minimise show command, conhost was started with a command line,
    /// ConPTY/headless, session 0 or an invisible window station. None of that can be imposed on a grandchild of the target.
    ///
    /// What we can do: every conhost.exe of a new console is started by its client, so it is a member of our job, and the job
    /// reports it (JOB_OBJECT_MSG_NEW_PROCESS on an I/O completion port) long before conhost gets to its handoff (it first has to load,
    /// read the connect message and initialise COM). Such a conhost is terminated at once: the console program fails to start (a
    /// "console-blocked" warning names it) instead of a window opening on the user's screen. Allowed: the windowless console of a
    /// console target (CREATE_NO_WINDOW: never handed off, and inherited by its children) and conhost.exe started by the harness itself
    /// with a command line ("console": true: never handed off, its window lives on the hidden desktop).
    ///
    /// Defence in depth (guard thread): a job process whose console is served by anything but %SystemRoot%\System32\conhost.exe was
    /// delegated (Windows Terminal's OpenConsole.exe): LEAK "console-delegated", the client is terminated and the Windows Terminal /
    /// console windows that appeared on the user's desktop since are closed.
    /// </summary>
    internal sealed partial class Host
    {
        static class Con
        {
            [StructLayout(LayoutKind.Sequential)]
            public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT { public IntPtr CompletionKey; public IntPtr CompletionPort; }
            [StructLayout(LayoutKind.Sequential)]
            public struct PROCESS_BASIC_INFORMATION { public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }

            [DllImport("kernel32", SetLastError = true)] public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
            [DllImport("kernel32", SetLastError = true)] public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr ov, uint ms);
            [DllImport("kernel32", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
            [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
            [DllImport("kernel32")] public static extern bool CloseHandle(IntPtr h);
            [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, System.Text.StringBuilder name, ref int size);
            [DllImport("ntdll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION info, int len, out int ret);
            [DllImport("ntdll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, out IntPtr info, int len, out int ret);
            [DllImport("user32")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

            public const uint PROCESS_TERMINATE = 0x1, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;
            public const int JobObjectAssociateCompletionPortInformation = 7, ProcessBasicInformation = 0, ProcessConsoleHostProcess = 49;
            public const uint JOB_OBJECT_MSG_NEW_PROCESS = 6;
        }

        IntPtr _jobPort; Thread _jobThread; int _jobKeys;
        readonly Dictionary<long, Proc> _jobByKey = new Dictionary<long, Proc>();
        static readonly string ConhostPath = Path.Combine(Environment.SystemDirectory, "conhost.exe");
        public long ConsolesBlocked;

        static string ImagePath(IntPtr h)
        {
            var sb = new System.Text.StringBuilder(1024); int n = sb.Capacity;
            return Con.QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString(0, n) : null;
        }

        static string ImageOf(int pid)
        {
            IntPtr h = Con.OpenProcess(Con.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return null;
            try { return ImagePath(h); } finally { Con.CloseHandle(h); }
        }

        static int ParentOf(IntPtr h)
        {
            var pbi = new Con.PROCESS_BASIC_INFORMATION(); int r;
            return Con.NtQueryInformationProcess(h, Con.ProcessBasicInformation, ref pbi, Marshal.SizeOf(typeof(Con.PROCESS_BASIC_INFORMATION)), out r) == 0 ? (int)pbi.InheritedFromUniqueProcessId.ToInt64() : 0;
        }

        /// <summary>The pid of the console server of a process (0 = no console). Low bits of the value are flags.</summary>
        static int ConsoleHostOf(int pid)
        {
            IntPtr h = Con.OpenProcess(Con.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return 0;
            try { IntPtr v; int r; return Con.NtQueryInformationProcess(h, Con.ProcessConsoleHostProcess, out v, IntPtr.Size, out r) == 0 ? (int)(v.ToInt64() & ~3L) : 0; }
            finally { Con.CloseHandle(h); }
        }

        /// <summary>Called right after the job is created, before any process is in it.</summary>
        void WatchJob(Proc p)
        {
            lock (_jobByKey)
            {
                if (_jobPort == IntPtr.Zero)
                {
                    _jobPort = Con.CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
                    if (_jobPort == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateIoCompletionPort failed");
                    _jobThread = new Thread(JobLoop) { IsBackground = true, Name = "jobs", Priority = ThreadPriority.Highest };
                    _jobThread.Start();
                }
                long key = ++_jobKeys; _jobByKey[key] = p;
                var info = new Con.JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey = new IntPtr(key), CompletionPort = _jobPort };
                SetJobInfo(p.Job, Con.JobObjectAssociateCompletionPortInformation, info);
            }
        }

        void JobLoop()
        {
            while (!_stop)
            {
                uint msg; IntPtr key, ov;
                if (!Con.GetQueuedCompletionStatus(_jobPort, out msg, out key, out ov, 200)) continue;
                if (msg != Con.JOB_OBJECT_MSG_NEW_PROCESS) continue;
                Proc p; lock (_jobByKey) _jobByKey.TryGetValue(key.ToInt64(), out p);
                try { OnJobProcess(p, (int)ov.ToInt64()); }
                catch (Exception ex) { Emit("error", "where", "jobs", "message", ex.Message); }
            }
        }

        void OnJobProcess(Proc p, int pid)
        {
            IntPtr h = Con.OpenProcess(Con.PROCESS_TERMINATE | Con.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return;
            try
            {
                string img = ImagePath(h);
                if (img == null || !string.Equals(img, ConhostPath, StringComparison.OrdinalIgnoreCase)) return;
                int parent = ParentOf(h);
                if (parent == SelfPid) return;                                            // "console": true - conhost.exe <cmdline> started by us: never hands off
                if (p != null && p.ConsoleNoWindow && parent == p.Pid) return;           // the windowless console of a console target
                bool killed = Con.TerminateProcess(h, 0xC0B);                             // a new console: it would be handed to the default terminal
                Interlocked.Increment(ref ConsolesBlocked);
                string client = parent > 0 ? ImageOf(parent) : null;
                Emit("guard", "kind", "console-blocked", "proc", p != null ? p.Id : null, "conhostPid", pid, "killed", killed,
                     "clientPid", parent, "client", client,
                     "message", "a console program (" + (client != null ? Path.GetFileName(client) : "pid " + parent) + ") asked for a new console window; it was blocked so the default terminal could not open it on your desktop");
            }
            finally { Con.CloseHandle(h); }
        }

        // ------------------------------------------------------------------ guard part (called from GuardLoop)

        // NOT PseudoConsoleWindow: every ConPTY session (other terminals, agents' shells) owns one; closing those would hurt the user
        static readonly string[] ConsoleWindowClasses = { "CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass" };
        HashSet<long> _consoleWnd0;   // console/terminal windows already on the user's desktop when the guard started
        long _consoleScanAt, _delegatedUntil;

        static bool IsConsoleishClass(string c) { return Array.IndexOf(ConsoleWindowClasses, c) >= 0; }

        HashSet<long> ConsoleWindowsNow()
        {
            var s = new HashSet<long>();
            Win.EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsConsoleishClass(Win.GetClass(h))) s.Add(h.ToInt64()); return true; }, IntPtr.Zero);
            return s;
        }

        void GuardConsoles(HashSet<int> pids)
        {
            if (_consoleWnd0 == null) _consoleWnd0 = ConsoleWindowsNow();
            if (Now < _consoleScanAt) return;
            _consoleScanAt = Now + 150;
            var delegated = new List<int>();
            foreach (int pid in pids)
            {
                int host = ConsoleHostOf(pid);
                if (host <= 0 || host == SelfPid || pids.Contains(host)) continue;
                // a GUI process (no console) reports its creator here, not a console server
                IntPtr hp = Con.OpenProcess(Con.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hp == IntPtr.Zero) continue;
                int parent; try { parent = ParentOf(hp); } finally { Con.CloseHandle(hp); }
                if (host == parent) continue;
                string img = ImageOf(host);
                if (img == null || string.Equals(img, ConhostPath, StringComparison.OrdinalIgnoreCase)) continue;   // inbox conhost (ours: job member, or a ConPTY): fine
                delegated.Add(pid); _delegatedUntil = Now + 8000;   // the terminal window may take a few seconds to appear
                Violation("condeleg:" + pid, "console-delegated", "pid", pid, "client", ImageOf(pid), "server", img, "serverPid", host,
                          "message", "a job process's console was handed to " + Path.GetFileName(img) + " (default terminal) on the user's desktop");
                IntPtr h = Con.OpenProcess(Con.PROCESS_TERMINATE, false, pid);   // our own job member
                if (h != IntPtr.Zero) { Con.TerminateProcess(h, 0xC0D); Con.CloseHandle(h); }
            }
            // any console/terminal window that appeared on the user's desktop during the run and belongs to a job process, or appeared
            // while a job process was being delegated: close it.
            foreach (long w in ConsoleWindowsNow())
            {
                if (_consoleWnd0.Contains(w)) continue;
                var hw = new IntPtr(w); int owner = Win.Pid(hw);
                // a conhost window of ours, or a NEW Windows Terminal window while one of our processes is being delegated
                bool ours = pids.Contains(owner) || (Now < _delegatedUntil && Win.GetClass(hw) == "CASCADIA_HOSTING_WINDOW_CLASS");
                if (!ours) continue;
                _consoleWnd0.Add(w);
                Con.PostMessage(hw, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero);
                Violation("conwnd:" + w, "window-on-user-desktop", "hwnd", Hx(hw), "class", Win.GetClass(hw), "title", Win.GetText(hw), "closed", true,
                          "message", "console/terminal window opened on the user's desktop by a job process (closed)");
            }
        }
    }
}
