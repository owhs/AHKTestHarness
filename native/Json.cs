using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>Tiny JSON helper (JavaScriptSerializer ships with .NET 4.0, so no dependencies).</summary>
    internal static class J
    {
        static readonly JavaScriptSerializer S = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };

        public static string Ser(object o) { return S.Serialize(o); }
        public static Dict Parse(string s) { return S.DeserializeObject(s) as Dict; }

        public static Dict O(params object[] kv)
        {
            var d = new Dict();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[Convert.ToString(kv[i])] = kv[i + 1];
            return d;
        }

        public static object Get(Dict d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
        public static bool Has(Dict d, string k) { return Get(d, k) != null; }

        public static string Str(Dict d, string k, string def)
        {
            object v = Get(d, k);
            if (v == null) return def;
            if (v is bool) return ((bool)v) ? "true" : "false";
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }
        public static string Str(Dict d, string k) { return Str(d, k, null); }

        public static long Long(Dict d, string k, long def)
        {
            object v = Get(d, k);
            if (v == null) return def;
            if (v is string) { long r; return long.TryParse((string)v, NumberStyles.Any, CultureInfo.InvariantCulture, out r) ? r : def; }
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); } catch { return def; }
        }
        public static int Int(Dict d, string k, int def) { return (int)Long(d, k, def); }

        public static double Dbl(Dict d, string k, double def)
        {
            object v = Get(d, k);
            if (v == null) return def;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return def; }
        }

        public static bool Bool(Dict d, string k, bool def)
        {
            object v = Get(d, k);
            if (v == null) return def;
            if (v is bool) return (bool)v;
            string s = Convert.ToString(v).ToLowerInvariant();
            return s == "true" || s == "1" || s == "yes";
        }

        public static Dict Obj(Dict d, string k) { return Get(d, k) as Dict; }

        public static List<object> Arr(Dict d, string k)
        {
            var l = new List<object>();
            var v = Get(d, k) as IEnumerable;
            if (v == null || v is string) return l;
            foreach (object o in v) l.Add(o);
            return l;
        }

        public static List<string> Strs(Dict d, string k)
        {
            var l = new List<string>();
            foreach (object o in Arr(d, k)) l.Add(Convert.ToString(o));
            return l;
        }

        /// <summary>IntPtr handle from a number or "0x1234" string.</summary>
        public static IntPtr Hwnd(Dict d, string k)
        {
            object v = Get(d, k);
            if (v == null) return IntPtr.Zero;
            string s = Convert.ToString(v, CultureInfo.InvariantCulture).Trim();
            try
            {
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return new IntPtr(Convert.ToInt64(s.Substring(2), 16));
                return new IntPtr(Convert.ToInt64(s, CultureInfo.InvariantCulture));
            }
            catch { return IntPtr.Zero; }
        }
    }
}
