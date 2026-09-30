using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Automation;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>UI Automation via the managed client (UIAutomationClient.dll, part of .NET 4). Runs on threads attached to the hidden desktop.</summary>
    internal sealed partial class Host
    {
        static string Trim(string programmatic)     // "ControlType.Button" -> "Button"
        {
            if (programmatic == null) return null;
            int i = programmatic.IndexOf('.');
            return i >= 0 ? programmatic.Substring(i + 1) : programmatic;
        }

        static string PatName(string programmatic)   // "InvokePatternIdentifiers.Pattern" -> "Invoke"
        {
            if (programmatic == null) return null;
            int i = programmatic.IndexOf('.');
            string s = i >= 0 ? programmatic.Substring(0, i) : programmatic;
            return s.Replace("PatternIdentifiers", "").Replace("Identifiers", "");
        }

        Dict UiaNode(AutomationElement e, string path)
        {
            var c = e.Current;
            var r = c.BoundingRectangle;
            var d = J.O("path", path, "name", c.Name, "automationId", c.AutomationId, "controlType", Trim(c.ControlType.ProgrammaticName), "className", c.ClassName,
                        "enabled", c.IsEnabled, "offscreen", c.IsOffscreen, "focusable", c.IsKeyboardFocusable);
            if (!r.IsEmpty && !double.IsInfinity(r.Left)) d["rect"] = new object[] { (int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom };
            if (c.NativeWindowHandle != 0) d["hwnd"] = Hx(new IntPtr(c.NativeWindowHandle));
            var pats = new List<object>();
            try
            {
                foreach (var p in e.GetSupportedPatterns()) pats.Add(PatName(p.ProgrammaticName));
            }
            catch { }
            d["patterns"] = pats;
            try
            {
                object o;
                if (e.TryGetCurrentPattern(ValuePattern.Pattern, out o)) d["value"] = ((ValuePattern)o).Current.Value;
                if (e.TryGetCurrentPattern(TogglePattern.Pattern, out o)) d["toggle"] = ((TogglePattern)o).Current.ToggleState.ToString();
                if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out o)) d["selected"] = ((SelectionItemPattern)o).Current.IsSelected;
                if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out o)) d["expand"] = ((ExpandCollapsePattern)o).Current.ExpandCollapseState.ToString();
            }
            catch { }
            return d;
        }

        /// <summary>Run f on a fresh thread attached to the hidden desktop; give up after timeoutMs (the thread is abandoned, never the process).</summary>
        T OnFreshDeskThread<T>(Func<T> f, int timeoutMs, out bool timedOut)
        {
            T res = default(T); Exception err = null;
            var t = new Thread(delegate ()
            {
                try { if (!Win.SetThreadDesktop(Desk)) throw new InvalidOperationException("SetThreadDesktop failed"); res = f(); }
                catch (Exception e) { err = e; }
            });
            t.IsBackground = true; t.SetApartmentState(ApartmentState.MTA); t.Start();
            timedOut = !t.Join(timeoutMs);
            if (timedOut) return default(T);
            if (err != null) throw new InvalidOperationException(err.GetType().Name + ": " + err.Message, err);
            return res;
        }

        public Dict UiaTree(Dict a)
        {
            IntPtr h = ResolveWindow(a); int maxDepth = J.Int(a, "depth", 8), cap = J.Int(a, "cap", 800);
            bool timedOut;
            var res = OnFreshDeskThread(delegate
            {
                var root = AutomationElement.FromHandle(h);
                var nodes = new List<object>();
                Walk(root, "", 0, maxDepth, cap, nodes);
                return J.O("hwnd", Hx(h), "count", nodes.Count, "nodes", nodes);
            }, J.Int(a, "timeoutMs", 15000), out timedOut);
            if (timedOut) throw new TimeoutException("UIA tree timed out (target may be busy)");
            return res;
        }

        static void Walk(AutomationElement e, string path, int depth, int maxDepth, int cap, List<object> outNodes)
        {
            if (outNodes.Count >= cap) return;
            Host self = I;
            outNodes.Add(self.UiaNode(e, path == "" ? "root" : path));
            if (depth >= maxDepth) return;
            AutomationElement child; int i = 0;
            try { child = TreeWalker.ControlViewWalker.GetFirstChild(e); } catch { return; }
            while (child != null && outNodes.Count < cap)
            {
                Walk(child, path == "" ? i.ToString() : path + "/" + i, depth + 1, maxDepth, cap, outNodes);
                i++;
                try { child = TreeWalker.ControlViewWalker.GetNextSibling(child); } catch { break; }
            }
        }

        static AutomationElement ByPath(AutomationElement root, string path)
        {
            if (string.IsNullOrEmpty(path) || path == "root") return root;
            AutomationElement cur = root;
            foreach (string part in path.Split('/'))
            {
                int idx = int.Parse(part);
                AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(cur);
                for (int i = 0; i < idx && child != null; i++) child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                if (child == null) throw new InvalidOperationException("UIA path not found: " + path);
                cur = child;
            }
            return cur;
        }

        /// <summary>action: invoke | toggle | expand | collapse | select | setvalue | focus | scrollinto</summary>
        public Dict UiaAct(Dict a)
        {
            IntPtr h = ResolveWindow(a); string path = J.Str(a, "path"); string action = J.Str(a, "action", "invoke"); string value = J.Str(a, "value");
            string name = J.Str(a, "name"), autoId = J.Str(a, "automationId");
            bool timedOut;
            var res = OnFreshDeskThread(delegate
            {
                var root = AutomationElement.FromHandle(h);
                AutomationElement el;
                if (path != null) el = ByPath(root, path);
                else
                {
                    var conds = new List<Condition>();
                    if (name != null) conds.Add(new PropertyCondition(AutomationElement.NameProperty, name));
                    if (autoId != null) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, autoId));
                    if (conds.Count == 0) throw new ArgumentException("give path, or name/automationId");
                    el = root.FindFirst(TreeScope.Descendants, conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray()));
                    if (el == null) throw new InvalidOperationException("UIA element not found");
                }
                switch (action)
                {
                    case "invoke": ((InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); break;
                    case "toggle": ((TogglePattern)el.GetCurrentPattern(TogglePattern.Pattern)).Toggle(); break;
                    case "expand": ((ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand(); break;
                    case "collapse": ((ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse(); break;
                    case "select": ((SelectionItemPattern)el.GetCurrentPattern(SelectionItemPattern.Pattern)).Select(); break;
                    case "setvalue": ((ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern)).SetValue(value ?? ""); break;
                    case "focus": el.SetFocus(); break;
                    case "scrollinto": ((ScrollItemPattern)el.GetCurrentPattern(ScrollItemPattern.Pattern)).ScrollIntoView(); break;
                    default: throw new ArgumentException("unknown UIA action " + action);
                }
                return UiaNode(el, path ?? "found");
            }, J.Int(a, "timeoutMs", 4000), out timedOut);
            // An Invoke that opens a modal dialog may not return until it is dismissed: report that as "started", not as a failure.
            if (timedOut) return J.O("timedOut", true, "note", "action was issued; target did not return (likely opened a modal dialog)");
            return res;
        }
    }
}
