using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>A process (tree) we launched. Lives in its own kill-on-close Job Object.</summary>
    internal sealed class Proc
    {
        public string Id;
        public int Pid;
        public IntPtr Job, HProc;
        public Stopwatch Clock = Stopwatch.StartNew();
        public string Exe, Args, OutPath, ErrPath, ScriptName;
        public long OutPos, ErrPos;
        public string OutPartial = "", ErrPartial = "";
        public bool Exited, Disposed, KillOnExit = true;
        public int ExitCode = -1;
        public string KillReason;
        public long DeadlineMs;            // 0 = none (ms on Proc.Clock)
        public bool Hung; public long HungSince; public long NextHangCheck;
        public HashSet<int> EverPids = new HashSet<int>();
    }

    /// <summary>
    /// The desktop host: owns ONE hidden Win32 desktop plus the jobs/processes launched on it.
    /// A dedicated thread is attached to that desktop and does every window operation, so callers on other
    /// threads never touch it directly.
    /// </summary>
    internal sealed partial class Host
    {
        public static Host I;
        public readonly Stopwatch Clock = Stopwatch.StartNew();
        public readonly DateTime Wall0 = DateTime.Now;
        readonly TextWriter _out;
        readonly object _outLock = new object();
        public string DeskName, StationName;
        public IntPtr Desk, Station;
        public bool StationMode; public string StationError, StationFlags;
        Thread _deskThread, _monThread;
        readonly BlockingCollection<Action> _q = new BlockingCollection<Action>();
        readonly ManualResetEvent _deskReady = new ManualResetEvent(false);
        string _deskError;
        volatile bool _stop;
        readonly Dictionary<string, Proc> _procs = new Dictionary<string, Proc>();
        public int ScreenW, ScreenH;

        public Host(TextWriter output) { _out = output; }

        public long Now { get { return Clock.ElapsedMilliseconds; } }

        // ------------------------------------------------------------------ events / IO

        public void Send(Dict d)
        {
            string s;
            try { s = J.Ser(d); }
            catch (Exception ex) { s = J.Ser(J.O("event", "error", "message", "serialize failed: " + ex.Message)); }
            lock (_outLock) { _out.WriteLine(s); _out.Flush(); }
        }

        public void Emit(string ev, params object[] kv)
        {
            var d = J.O("event", ev, "t", Now, "ts", DateTime.Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff"));
            for (int i = 0; i + 1 < kv.Length; i += 2) d[Convert.ToString(kv[i])] = kv[i + 1];
            Send(d);
        }

        // ------------------------------------------------------------------ desktop

        /// <summary>
        /// useStation: create a PRIVATE WINDOW STATION and put this whole process in it before creating the desktop. A window station owns
        /// the clipboard, atom table and hooks, so a sandboxed script can no longer wipe/replace the user's clipboard (a job UI limit blocks
        /// SetClipboardData but NOT EmptyClipboard - the selftest caught that). Falls back to a plain hidden desktop in WinSta0 if it fails.
        /// </summary>
        public void Start(string deskName, bool useStation)
        {
            try { Win.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            Win.SetErrorMode(Win.SEM_FAILCRITICALERRORS | Win.SEM_NOGPFAULTERRORBOX | Win.SEM_NOOPENFILEERRORBOX);
            string tag = Process.GetCurrentProcess().Id + "_" + Guid.NewGuid().ToString("N").Substring(0, 6);
            DeskName = deskName ?? ("AHKH_" + tag);
            if (useStation)
            {
                StationName = "AHKH_WS_" + tag;
                Station = Win.CreateWindowStation(StationName, 0, Win.WINSTA_ALL_ACCESS, IntPtr.Zero);
                if (Station == IntPtr.Zero)
                {
                    int e1 = Marshal.GetLastWin32Error();
                    // A user process may not create a NAMED station (access denied); a NULL name lets the system derive one from the logon session.
                    Station = Win.CreateWindowStation(null, 0, Win.WINSTA_ALL_ACCESS, IntPtr.Zero);
                    if (Station != IntPtr.Zero) StationName = Win.ObjectName(Station);
                    else StationError = "CreateWindowStation failed: named=" + e1 + " null-name=" + Marshal.GetLastWin32Error();
                }
                if (Station == IntPtr.Zero) { /* StationError set above */ }
                else if (!Win.SetProcessWindowStation(Station)) StationError = "SetProcessWindowStation failed: " + Marshal.GetLastWin32Error();
                else
                {
                    StationMode = true;
                    // Windows in a non-visible station are never shown (AHK then exits: it sees no visible GUI). Try to mark ours visible.
                    var fl = new Win.USEROBJECTFLAGS(); int need;
                    Win.GetUserObjectInformation(Station, Win.UOI_FLAGS, ref fl, Marshal.SizeOf(typeof(Win.USEROBJECTFLAGS)), out need);
                    int before = fl.dwFlags; fl.dwFlags |= Win.WSF_VISIBLE;
                    bool set = Win.SetUserObjectInformation(Station, Win.UOI_FLAGS, ref fl, Marshal.SizeOf(typeof(Win.USEROBJECTFLAGS)));
                    int err = set ? 0 : Marshal.GetLastWin32Error();
                    Win.GetUserObjectInformation(Station, Win.UOI_FLAGS, ref fl, Marshal.SizeOf(typeof(Win.USEROBJECTFLAGS)), out need);
                    StationFlags = "before=" + before + " set=" + set + (set ? "" : " err=" + err) + " after=" + fl.dwFlags;
                }
                if (!StationMode) { StationName = null; if (Station != IntPtr.Zero) { Win.CloseWindowStation(Station); Station = IntPtr.Zero; } }
            }
            Desk = Win.CreateDesktop(DeskName, IntPtr.Zero, IntPtr.Zero, 0, Win.GENERIC_ALL, IntPtr.Zero);
            if (Desk == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop failed");
            _deskThread = new Thread(DeskLoop) { IsBackground = true, Name = "desk" };
            _deskThread.Start();
            _deskReady.WaitOne();
            if (_deskError != null) throw new InvalidOperationException(_deskError);
            _monThread = new Thread(MonLoop) { IsBackground = true, Name = "mon" };
            _monThread.Start();
            if (!StationMode) StartGuard();   // in station mode the target cannot reach the user's session at all
        }

        void DeskLoop()
        {
            if (!Win.SetThreadDesktop(Desk)) _deskError = "SetThreadDesktop failed: " + Marshal.GetLastWin32Error();
            else { ScreenW = Win.GetSystemMetrics(0); ScreenH = Win.GetSystemMetrics(1); }
            _deskReady.Set();
            if (_deskError != null) return;
            long lastTick = 0;
            while (!_stop)
            {
                Action a;
                if (_q.TryTake(out a, 10))
                {
                    try { a(); } catch (Exception ex) { Emit("error", "where", "desk-task", "message", ex.Message); }
                }
                long now = Now;
                bool busy; lock (_procs) busy = _procs.Count > 0;
                if (now - lastTick >= (busy ? 20 : 100))
                {
                    lastTick = now;
                    try { Tick(); } catch (Exception ex) { Emit("error", "where", "tick", "message", ex.ToString()); }
                }
            }
        }

        /// <summary>Runs f on the desktop-attached thread and waits for the result.</summary>
        public T OnDesk<T>(Func<T> f, int timeoutMs)
        {
            if (Thread.CurrentThread == _deskThread) return f();
            T res = default(T); Exception err = null; var done = new ManualResetEvent(false);
            _q.Add(delegate { try { res = f(); } catch (Exception e) { err = e; } finally { done.Set(); } });
            if (!done.WaitOne(timeoutMs)) throw new TimeoutException("desktop thread busy (" + timeoutMs + "ms)");
            if (err != null) throw new InvalidOperationException(err.Message, err);
            return res;
        }
        public T OnDesk<T>(Func<T> f) { return OnDesk(f, 20000); }

        public void Shutdown()
        {
            _stop = true;
            Proc[] ps; lock (_procs) ps = new List<Proc>(_procs.Values).ToArray();
            foreach (var p in ps) { try { Win.TerminateJobObject(p.Job, 0xA11); } catch { } }
            Thread.Sleep(50);
            foreach (var p in ps) DisposeProc(p);
            try { _deskThread.Join(1500); } catch { }
            try { Win.CloseDesktop(Desk); } catch { }
        }

        // ------------------------------------------------------------------ processes

        static IntPtr CreateJob(ulong memLimit, bool clipboardBlock)
        {
            IntPtr job = Win.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
            var ext = new Win.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            ext.BasicLimitInformation.LimitFlags = Win.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Win.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if (memLimit > 0) { ext.BasicLimitInformation.LimitFlags |= Win.JOB_OBJECT_LIMIT_PROCESS_MEMORY; ext.ProcessMemoryLimit = new UIntPtr(memLimit); }
            SetJobInfo(job, Win.JobObjectExtendedLimitInformation, ext);
            uint ui = Win.UILIMIT_SYSTEMPARAMETERS | Win.UILIMIT_DISPLAYSETTINGS | Win.UILIMIT_DESKTOP | Win.UILIMIT_EXITWINDOWS;
            if (clipboardBlock) ui |= Win.UILIMIT_READCLIPBOARD | Win.UILIMIT_WRITECLIPBOARD;
            SetJobInfo(job, Win.JobObjectBasicUIRestrictions, ui);
            return job;
        }

        static void SetJobInfo<T>(IntPtr job, int cls, T value)
        {
            int size = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(value, p, false);
                if (!Win.SetInformationJobObject(job, cls, p, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(" + cls + ") failed");
            }
            finally { Marshal.FreeHGlobal(p); }
        }

        public static List<int> JobPids(IntPtr job)
        {
            var list = new List<int>(); const int max = 256; int size = 8 + max * IntPtr.Size; IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                uint ret;
                if (Win.QueryInformationJobObject(job, Win.JobObjectBasicProcessIdList, buf, (uint)size, out ret))
                {
                    int n = Marshal.ReadInt32(buf, 4);
                    for (int i = 0; i < n && i < max; i++) list.Add((int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64());
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
            return list;
        }

        static IntPtr BuildEnv(Dict overrides)
        {
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[Convert.ToString(e.Key)] = Convert.ToString(e.Value);
            if (overrides != null)
                foreach (var kv in overrides)
                {
                    if (kv.Value == null) env.Remove(kv.Key); else env[kv.Key] = Convert.ToString(kv.Value);
                }
            var sb = new StringBuilder();
            foreach (var kv in env) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
            sb.Append('\0');
            return Marshal.StringToHGlobalUni(sb.ToString());
        }

        public Dict StartProc(Dict a)
        {
            string id = J.Str(a, "proc", "p" + (_procs.Count + 1));   // NB: "id" is the request id, never the proc id
            string exe = J.Str(a, "exe"); string args = J.Str(a, "args", "");
            if (string.IsNullOrEmpty(exe)) throw new ArgumentException("exe required");
            lock (_procs) if (_procs.ContainsKey(id)) throw new ArgumentException("proc id already in use: " + id);
            string outPath = J.Str(a, "stdout"), errPath = J.Str(a, "stderr"), inPath = J.Str(a, "stdin");
            string cwd = J.Str(a, "cwd") ?? Path.GetDirectoryName(exe);
            var p = new Proc { Id = id, Exe = exe, Args = args, OutPath = outPath, ErrPath = errPath, ScriptName = J.Str(a, "scriptName"), KillOnExit = J.Bool(a, "killOnExit", true) };
            long timeout = J.Long(a, "timeoutMs", 0);
            if (timeout > 0) p.DeadlineMs = timeout;
            p.Job = CreateJob((ulong)J.Long(a, "memMb", 2048) * 1024UL * 1024UL, J.Bool(a, "blockClipboard", true));
            var pi = new Win.PROCESS_INFORMATION();
            IntPtr env = IntPtr.Zero;
            try
            {
                lock (LaunchLock)
                {
                    var sa = new Win.SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(Win.SECURITY_ATTRIBUTES)); sa.bInheritHandle = true;
                    uint share = Win.FILE_SHARE_READ | Win.FILE_SHARE_WRITE | Win.FILE_SHARE_DELETE;
                    IntPtr hOut = outPath != null ? Win.CreateFile(outPath, Win.GENERIC_WRITE, share, ref sa, Win.CREATE_ALWAYS, Win.FILE_ATTRIBUTE_NORMAL, IntPtr.Zero) : IntPtr.Zero;
                    IntPtr hErr = errPath != null ? Win.CreateFile(errPath, Win.GENERIC_WRITE, share, ref sa, Win.CREATE_ALWAYS, Win.FILE_ATTRIBUTE_NORMAL, IntPtr.Zero) : IntPtr.Zero;
                    IntPtr hIn = inPath != null ? Win.CreateFile(inPath, Win.GENERIC_READ, share, ref sa, Win.OPEN_EXISTING, 0, IntPtr.Zero)
                                                : Win.CreateFile("NUL", Win.GENERIC_READ, share, ref sa, Win.OPEN_EXISTING, 0, IntPtr.Zero);
                    try
                    {
                        var si = new Win.STARTUPINFO();
                        si.cb = Marshal.SizeOf(typeof(Win.STARTUPINFO));
                        si.lpDesktop = (StationMode ? StationName : "WinSta0") + "\\" + DeskName;
                        si.dwFlags = Win.STARTF_USESTDHANDLES | Win.STARTF_USESHOWWINDOW;
                        string show = J.Str(a, "show", "na");
                        si.wShowWindow = show == "hidden" ? Win.SW_HIDE : show == "normal" ? Win.SW_SHOWNORMAL : Win.SW_SHOWNOACTIVATE;
                        si.hStdInput = hIn;
                        si.hStdOutput = hOut != IntPtr.Zero ? hOut : hIn;
                        si.hStdError = hErr != IntPtr.Zero ? hErr : (hOut != IntPtr.Zero ? hOut : hIn);
                        var cmd = new StringBuilder(J.Str(a, "cmdline") ?? ("\"" + exe + "\" " + args));
                        env = BuildEnv(J.Obj(a, "env"));
                        bool ok = Win.CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, Win.CREATE_SUSPENDED | Win.CREATE_UNICODE_ENVIRONMENT, env, cwd, ref si, out pi);
                        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed for " + exe);
                    }
                    finally
                    {
                        if (hOut != IntPtr.Zero) Win.CloseHandle(hOut);
                        if (hErr != IntPtr.Zero) Win.CloseHandle(hErr);
                        Win.CloseHandle(hIn);
                    }
                }
                if (!Win.AssignProcessToJobObject(p.Job, pi.hProcess))
                {
                    int e = Marshal.GetLastWin32Error();
                    Win.TerminateOwn(pi.hProcess);   // suspended, ours, never resumed
                    throw new Win32Exception(e, "AssignProcessToJobObject failed");
                }
                p.Pid = pi.dwProcessId; p.HProc = pi.hProcess; p.EverPids.Add(p.Pid);
                lock (_procs) _procs[id] = p;
                p.Clock.Restart();
                Win.ResumeThread(pi.hThread);
                Win.CloseHandle(pi.hThread);
            }
            catch
            {
                if (p.Job != IntPtr.Zero) { Win.TerminateJobObject(p.Job, 0xA12); Win.CloseHandle(p.Job); }
                if (pi.hProcess != IntPtr.Zero) Win.CloseHandle(pi.hProcess);
                throw;
            }
            finally { if (env != IntPtr.Zero) Marshal.FreeHGlobal(env); }
            Emit("proc.start", "proc", id, "pid", p.Pid, "exe", exe, "args", args);
            return J.O("id", id, "pid", p.Pid, "desktop", DeskName);
        }

        internal static readonly object LaunchLock = new object();

        public Proc GetProc(string id)
        {
            lock (_procs)
            {
                Proc p; if (id != null && _procs.TryGetValue(id, out p)) return p;
                if (id == null && _procs.Count == 1) foreach (var v in _procs.Values) return v;
            }
            throw new ArgumentException("unknown proc: " + id);
        }

        public Proc[] AllProcs() { lock (_procs) return new List<Proc>(_procs.Values).ToArray(); }

        public void KillProc(Proc p, uint code, string reason)
        {
            if (p.KillReason == null) p.KillReason = reason;
            try { Win.TerminateJobObject(p.Job, code); } catch { }
        }

        public void DisposeProc(Proc p)
        {
            if (p.Disposed) return; p.Disposed = true;
            FlushTail(p);
            try { Win.TerminateJobObject(p.Job, 0xA11); } catch { }
            try { Win.CloseHandle(p.Job); } catch { }
            try { Win.CloseHandle(p.HProc); } catch { }
            lock (_procs) _procs.Remove(p.Id);
        }

        static string NtName(uint c)
        {
            switch (c)
            {
                case 0xC0000005: return "ACCESS_VIOLATION";
                case 0xC00000FD: return "STACK_OVERFLOW";
                case 0xC0000409: return "STACK_BUFFER_OVERRUN";
                case 0xC0000374: return "HEAP_CORRUPTION";
                case 0xC0000017: return "NO_MEMORY";
                case 0xC000001D: return "ILLEGAL_INSTRUCTION";
                case 0xC0000142: return "DLL_INIT_FAILED";
                case 0xC0000135: return "DLL_NOT_FOUND";
                case 0xC000013A: return "CONTROL_C_EXIT";
                case 0xE06D7363: return "CPP_EXCEPTION";
                case 0xA11: return "KILLED_BY_HARNESS";
                case 0xE77: return "KILLED_ON_ERROR";
            }
            return null;
        }

        // ------------------------------------------------------------------ monitor thread: output tail, exit, deadline

        void MonLoop()
        {
            while (!_stop)
            {
                foreach (var p in AllProcs())
                {
                    if (p.Disposed) continue;
                    try { MonOne(p); } catch (Exception ex) { Emit("error", "where", "mon", "message", ex.Message); }
                }
                Thread.Sleep(40);
            }
        }

        void MonOne(Proc p)
        {
            TailOnce(p, false); TailOnce(p, true);
            if (p.Exited) return;
            uint w = Win.WaitForSingleObject(p.HProc, 0);
            if (w == Win.WAIT_OBJECT_0)
            {
                uint code; Win.GetExitCodeProcess(p.HProc, out code);
                p.Exited = true; p.ExitCode = unchecked((int)code);
                Thread.Sleep(30); FlushTail(p);
                string nt = NtName(code);
                Emit("proc.exit", "proc", p.Id, "pid", p.Pid, "code", p.ExitCode, "hex", "0x" + code.ToString("X"), "name", nt,
                     "elapsedMs", p.Clock.ElapsedMilliseconds, "killedBy", p.KillReason,
                     "crashed", (code & 0xC0000000) == 0xC0000000 && code != 0xC000013A);
                if (p.KillOnExit) { try { Win.TerminateJobObject(p.Job, 0xA11); } catch { } }
                return;
            }
            if (p.DeadlineMs > 0 && p.Clock.ElapsedMilliseconds > p.DeadlineMs && p.KillReason == null)
            {
                Emit("proc.timeout", "proc", p.Id, "afterMs", p.Clock.ElapsedMilliseconds);
                KillProc(p, 0xA11, "timeout");
            }
        }

        void TailOnce(Proc p, bool err)
        {
            string path = err ? p.ErrPath : p.OutPath; if (path == null) return;
            long pos = err ? p.ErrPos : p.OutPos;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length <= pos) return;
                    fs.Seek(pos, SeekOrigin.Begin);
                    var buf = new byte[(int)Math.Min(fs.Length - pos, 1 << 20)];
                    int n = fs.Read(buf, 0, buf.Length);
                    if (n <= 0) return;
                    if (err) p.ErrPos += n; else p.OutPos += n;
                    string text = Encoding.UTF8.GetString(buf, 0, n);
                    string partial = err ? p.ErrPartial : p.OutPartial;
                    text = partial + text;
                    int last = text.LastIndexOf('\n');
                    string keep = last < 0 ? text : text.Substring(last + 1);
                    if (last >= 0)
                        foreach (string line in text.Substring(0, last).Split('\n'))
                            Emit("out", "proc", p.Id, "stream", err ? "err" : "out", "text", line.TrimEnd('\r'));
                    if (err) p.ErrPartial = last < 0 ? text : keep; else p.OutPartial = last < 0 ? text : keep;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        void FlushTail(Proc p)
        {
            TailOnce(p, false); TailOnce(p, true);
            if (p.OutPartial.Length > 0) { Emit("out", "proc", p.Id, "stream", "out", "text", p.OutPartial.TrimEnd('\r')); p.OutPartial = ""; }
            if (p.ErrPartial.Length > 0) { Emit("out", "proc", p.Id, "stream", "err", "text", p.ErrPartial.TrimEnd('\r')); p.ErrPartial = ""; }
        }

        public Dict ProcInfo(Proc p)
        {
            var d = J.O("id", p.Id, "pid", p.Pid, "exited", p.Exited, "exitCode", p.Exited ? (object)p.ExitCode : null,
                        "elapsedMs", p.Clock.ElapsedMilliseconds, "killedBy", p.KillReason);
            var pids = new List<object>();
            if (!p.Disposed) foreach (int x in JobPids(p.Job)) { pids.Add(x); p.EverPids.Add(x); }
            d["pids"] = pids;
            return d;
        }

        /// <summary>CPU time / memory / handle counts, for leak trends during long smoke runs.</summary>
        public Dict Metrics(Proc p)
        {
            var list = new List<object>();
            foreach (int pid in JobPids(p.Job))
            {
                try
                {
                    using (var pr = Process.GetProcessById(pid))
                    {
                        list.Add(J.O("pid", pid, "name", pr.ProcessName, "workingSetMB", Math.Round(pr.WorkingSet64 / 1048576.0, 1),
                            "privateMB", Math.Round(pr.PrivateMemorySize64 / 1048576.0, 1), "handles", pr.HandleCount, "threads", pr.Threads.Count,
                            "cpuMs", (long)pr.TotalProcessorTime.TotalMilliseconds,
                            "gdi", Win.GetGuiResources(pr.Handle, 0), "user", Win.GetGuiResources(pr.Handle, 1)));
                    }
                }
                catch { }
            }
            return J.O("proc", p.Id, "t", Now, "processes", list);
        }
    }
}
