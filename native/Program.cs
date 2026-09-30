using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>
    /// ahkh-host.exe : JSON-lines RPC over stdin/stdout.
    ///   request : {"id":1,"cmd":"win.list","proc":"p1",...}
    ///   reply   : {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"..."}
    ///   events  : {"event":"dialog","t":1234,...}   (no id)
    /// One host process owns one hidden desktop. Closing stdin tears everything down (kill-on-close jobs).
    /// </summary>
    internal static class Program
    {
        public const string Version = "0.1.0";

        static int Main(string[] args)
        {
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string deskName = null; bool noDesk = false; bool station = false;   // private window station: perfect clipboard isolation but GUI windows are never shown in it, so opt-in only
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--desktop" && i + 1 < args.Length) deskName = args[++i];
                else if (args[i] == "--images-only") noDesk = true;
                else if (args[i] == "--station") station = true;
                else if (args[i] == "--version") { stdout.WriteLine(Version); stdout.Flush(); return 0; }
            }
            var host = new Host(stdout);
            Host.I = host;
            try { if (!noDesk) host.Start(deskName, station); }
            catch (Exception ex)
            {
                host.Send(J.O("event", "fatal", "message", "desktop start failed: " + ex.Message));
                return 2;
            }
            host.Emit("ready", "version", Version, "pid", System.Diagnostics.Process.GetCurrentProcess().Id, "desktop", host.DeskName,
                      "screen", new object[] { host.ScreenW, host.ScreenH }, "images", noDesk, "station", host.StationName, "stationMode", host.StationMode, "stationError", host.StationError, "stationFlags", host.StationFlags);

            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                line = line.Trim(); if (line.Length == 0) continue;
                Dict req;
                try { req = J.Parse(line); }
                catch (Exception ex) { host.Send(J.O("event", "error", "message", "bad json: " + ex.Message)); continue; }
                if (req == null) continue;
                if (J.Str(req, "cmd") == "quit") { host.Send(J.O("id", J.Get(req, "id"), "ok", true, "result", J.O("bye", true))); break; }
                var r = req;
                ThreadPool.QueueUserWorkItem(delegate { Rpc.Handle(host, r); });
            }
            if (!noDesk) host.Shutdown();
            return 0;
        }
    }

    internal static class Rpc
    {
        public static void Handle(Host h, Dict req)
        {
            object id = J.Get(req, "id"); string cmd = J.Str(req, "cmd");
            try
            {
                object res = Dispatch(h, cmd, req);
                h.Send(J.O("id", id, "ok", true, "result", res));
            }
            catch (Exception ex)
            {
                Exception inner = ex; while (inner.InnerException != null && ex is InvalidOperationException) inner = inner.InnerException;
                h.Send(J.O("id", id, "ok", false, "error", inner.Message, "type", inner.GetType().Name));
            }
        }

        static object Dispatch(Host h, string cmd, Dict a)
        {
            switch (cmd)
            {
                case "hello": return J.O("version", Program.Version, "desktop", h.DeskName, "screen", new object[] { h.ScreenW, h.ScreenH }, "now", h.Now);
                case "desk.info": return J.O("desktop", h.DeskName, "screen", new object[] { h.ScreenW, h.ScreenH }, "desktops", Host.ListDesktops());
                case "desk.list": return Host.ListDesktops();
                case "sys.snapshot": return Host.SessionSnapshot();

                case "proc.start": return h.StartProc(a);
                case "proc.kill": { var p = h.GetProc(J.Str(a, "proc")); h.KillProc(p, 0xA11, J.Str(a, "reason", "requested")); return J.O("killed", true); }
                case "proc.info": return h.ProcInfo(h.GetProc(J.Str(a, "proc")));
                case "proc.list": { var l = new List<object>(); foreach (var p in h.AllProcs()) l.Add(h.ProcInfo(p)); return l; }
                case "proc.metrics": return h.Metrics(h.GetProc(J.Str(a, "proc")));
                case "proc.deadline": { var p = h.GetProc(J.Str(a, "proc")); p.DeadlineMs = p.Clock.ElapsedMilliseconds + J.Long(a, "inMs", 0); return J.O("ok", true); }
                case "proc.dispose": { var p = h.GetProc(J.Str(a, "proc")); h.DisposeProc(p); return J.O("disposed", true); }

                case "rules.set": h.SetRules(J.Arr(a, "rules")); return J.O("count", J.Arr(a, "rules").Count);
                case "shots.auto": h.OnDesk(delegate { h.SetAutoShots(a); return 0; }); return J.O("ok", true);
                case "shot": return h.OnDesk(delegate { return h.Shot(a); }, 30000);

                case "win.list": return h.ListWindows(a);
                case "win.tree": return h.Tree(a);
                case "win.at": return h.WindowAt(a);
                case "win.click": return h.Click(a);
                case "win.press": return h.Press(a);
                case "win.text": return h.SetText(a);
                case "win.key": return h.Key(a);
                case "win.type": return h.Type(a);
                case "win.select": return h.Select(a);
                case "win.check": return h.Check(a);
                case "win.close": return h.WinAction(a, "close");
                case "win.wmclose": return h.WinAction(a, "wmclose");
                case "win.minimize": return h.WinAction(a, "minimize");
                case "win.maximize": return h.WinAction(a, "maximize");
                case "win.restore": return h.WinAction(a, "restore");
                case "win.move": return h.WinAction(a, "move");
                case "win.msg": return h.RawMessage(a);

                case "uia.tree": return h.UiaTree(a);
                case "uia.act": return h.UiaAct(a);

                case "guard.report": return h.GuardReport();
                case "guard.reset": return h.GuardReset();
                case "clip.config": h.RestoreClipboard = J.Bool(a, "restore", true); return J.O("restore", h.RestoreClipboard);

                case "img.info": return Imaging.Info(a);
                case "img.crop": return Imaging.Crop(a);
                case "img.sheet": return Imaging.Sheet(a);
                case "img.diff": return Imaging.Diff(a);
                case "img.annotate": return Imaging.Annotate(a);
                case "img.pixel": return Imaging.Pixel(a);
                case "img.dominant": return Imaging.Dominant(a);
            }
            throw new ArgumentException("unknown command: " + cmd);
        }
    }
}
