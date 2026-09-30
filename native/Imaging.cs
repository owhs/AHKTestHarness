using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Ahkh
{
    using Dict = Dictionary<string, object>;

    /// <summary>Pure image tools (no desktop needed): resize, crop, contact sheet, diff, annotate, pixel probes.</summary>
    internal static class Imaging
    {
        public static Bitmap Resize(Bitmap src, double scale)
        {
            int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
            var dst = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = scale < 1 ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half; g.SmoothingMode = SmoothingMode.HighQuality;
                g.DrawImage(src, new Rectangle(0, 0, w, h), new Rectangle(0, 0, src.Width, src.Height), GraphicsUnit.Pixel);
            }
            return dst;
        }

        static Bitmap Load(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var img = Image.FromStream(fs)) { return new Bitmap(img); }   // detach from the file
        }

        public static Dict Info(Dict a)
        {
            using (var b = Load(J.Str(a, "src"))) return J.O("width", b.Width, "height", b.Height, "blank", Host.IsBlank(b));
        }

        public static Dict Crop(Dict a)
        {
            string src = J.Str(a, "src"), dst = J.Str(a, "out");
            var rect = J.Arr(a, "rect"); double scale = J.Dbl(a, "scale", 1.0);
            using (var b = Load(src))
            {
                var r = new Rectangle(0, 0, b.Width, b.Height);
                if (rect.Count == 4) r = Rectangle.Intersect(r, new Rectangle(Convert.ToInt32(rect[0]), Convert.ToInt32(rect[1]), Convert.ToInt32(rect[2]), Convert.ToInt32(rect[3])));
                if (r.Width <= 0 || r.Height <= 0) throw new ArgumentException("crop rect outside image");
                using (var c = b.Clone(r, PixelFormat.Format32bppArgb))
                {
                    Bitmap o = Math.Abs(scale - 1.0) > 0.001 ? Resize(c, scale) : null;
                    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(dst)));
                    (o ?? c).Save(dst, ImageFormat.Png);
                    var res = J.O("path", dst, "width", (o ?? c).Width, "height", (o ?? c).Height);
                    if (o != null) o.Dispose();
                    return res;
                }
            }
        }

        /// <summary>Stitch many shots into one labelled image (a filmstrip / contact sheet) so a reader needs one look, not thirty.</summary>
        public static Dict Sheet(Dict a)
        {
            var files = J.Strs(a, "files"); var labels = J.Strs(a, "labels");
            string dst = J.Str(a, "out"); int cols = Math.Max(1, J.Int(a, "cols", 3)); int cellW = Math.Max(120, J.Int(a, "cellWidth", 480));
            if (files.Count == 0) throw new ArgumentException("no files");
            var cells = new List<Bitmap>(); var heights = new List<int>();
            try
            {
                foreach (string f in files)
                {
                    Bitmap b = Load(f);
                    double s = Math.Min(1.0, (double)cellW / b.Width);
                    Bitmap r = Resize(b, s); b.Dispose(); cells.Add(r);
                }
                int rows = (files.Count + cols - 1) / cols; const int lab = 20, pad = 6;
                var rowH = new int[rows];
                for (int i = 0; i < cells.Count; i++) rowH[i / cols] = Math.Max(rowH[i / cols], cells[i].Height);
                int W = cols * (cellW + pad) + pad, H = pad; foreach (int rh in rowH) H += rh + lab + pad;
                using (var sheet = new Bitmap(W, H, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(sheet))
                using (var font = new Font("Segoe UI", 9f))
                {
                    g.Clear(Color.FromArgb(24, 26, 31)); g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                    int y = pad;
                    for (int r = 0; r < rows; r++)
                    {
                        for (int c = 0; c < cols; c++)
                        {
                            int i = r * cols + c; if (i >= cells.Count) break;
                            int x = pad + c * (cellW + pad);
                            string text = i < labels.Count ? labels[i] : Path.GetFileNameWithoutExtension(files[i]);
                            g.DrawString(text, font, Brushes.Gainsboro, new RectangleF(x, y, cellW, lab));
                            g.DrawImageUnscaled(cells[i], x, y + lab);
                            g.DrawRectangle(Pens.DimGray, x, y + lab, cells[i].Width - 1, cells[i].Height - 1);
                        }
                        y += rowH[r] + lab + pad;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(dst)));
                    sheet.Save(dst, ImageFormat.Png);
                    return J.O("path", dst, "width", W, "height", H, "cells", cells.Count);
                }
            }
            finally { foreach (var c in cells) c.Dispose(); }
        }

        /// <summary>Per-pixel comparison with tolerance; optionally writes a red-highlight diff image.</summary>
        public static Dict Diff(Dict a)
        {
            using (Bitmap A = Load(J.Str(a, "a")))
            using (Bitmap B = Load(J.Str(a, "b")))
            {
                int tol = J.Int(a, "tolerance", 8); string outPath = J.Str(a, "out");
                var mask = J.Arr(a, "region");
                if (A.Width != B.Width || A.Height != B.Height)
                    return J.O("same", false, "sizeMismatch", true, "aSize", A.Width + "x" + A.Height, "bSize", B.Width + "x" + B.Height, "changedPct", 100.0);
                int W = A.Width, H = A.Height, x0 = 0, y0 = 0, x1 = W, y1 = H;
                if (mask.Count == 4) { x0 = Math.Max(0, Convert.ToInt32(mask[0])); y0 = Math.Max(0, Convert.ToInt32(mask[1])); x1 = Math.Min(W, x0 + Convert.ToInt32(mask[2])); y1 = Math.Min(H, y0 + Convert.ToInt32(mask[3])); }
                var ra = new Rectangle(0, 0, W, H);
                var da = A.LockBits(ra, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var db = B.LockBits(ra, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                Bitmap D = outPath != null ? new Bitmap(W, H, PixelFormat.Format32bppArgb) : null;
                BitmapData dd = D != null ? D.LockBits(ra, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb) : null;
                long changed = 0; int minX = W, minY = H, maxX = -1, maxY = -1;
                try
                {
                    var rowA = new byte[W * 4]; var rowB = new byte[W * 4]; var rowD = new byte[W * 4];
                    for (int y = 0; y < H; y++)
                    {
                        Marshal.Copy(new IntPtr(da.Scan0.ToInt64() + (long)y * da.Stride), rowA, 0, rowA.Length);
                        Marshal.Copy(new IntPtr(db.Scan0.ToInt64() + (long)y * db.Stride), rowB, 0, rowB.Length);
                        for (int x = 0; x < W; x++)
                        {
                            int i = x * 4;
                            bool inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                            int d = Math.Max(Math.Abs(rowA[i] - rowB[i]), Math.Max(Math.Abs(rowA[i + 1] - rowB[i + 1]), Math.Abs(rowA[i + 2] - rowB[i + 2])));
                            bool diff = inside && d > tol;
                            if (diff) { changed++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
                            if (D != null)
                            {
                                byte g = (byte)((rowA[i] + rowA[i + 1] + rowA[i + 2]) / 6);   // dimmed grayscale
                                rowD[i] = diff ? (byte)40 : g; rowD[i + 1] = diff ? (byte)40 : g; rowD[i + 2] = diff ? (byte)255 : g; rowD[i + 3] = 255;
                            }
                        }
                        if (D != null) Marshal.Copy(rowD, 0, new IntPtr(dd.Scan0.ToInt64() + (long)y * dd.Stride), rowD.Length);
                    }
                }
                finally { A.UnlockBits(da); B.UnlockBits(db); if (D != null) { D.UnlockBits(dd); } }
                long area = (long)(x1 - x0) * (y1 - y0);
                double pct = area > 0 ? Math.Round(100.0 * changed / area, 4) : 0;
                var res = J.O("same", changed == 0, "changedPixels", changed, "changedPct", pct, "width", W, "height", H,
                              "bbox", changed > 0 ? new object[] { minX, minY, maxX - minX + 1, maxY - minY + 1 } : null);
                if (D != null) { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))); D.Save(outPath, ImageFormat.Png); D.Dispose(); res["diffPath"] = outPath; }
                return res;
            }
        }

        /// <summary>Draw numbered boxes over a screenshot ("set of marks") so a reader can refer to controls by number.</summary>
        public static Dict Annotate(Dict a)
        {
            string src = J.Str(a, "src"), dst = J.Str(a, "out"); int ox = J.Int(a, "originX", 0), oy = J.Int(a, "originY", 0);
            using (var b = Load(src))
            using (var g = Graphics.FromImage(b))
            using (var font = new Font("Segoe UI", 9f, FontStyle.Bold))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                var palette = new[] { Color.FromArgb(255, 64, 64), Color.FromArgb(46, 160, 67), Color.FromArgb(56, 132, 244), Color.FromArgb(230, 150, 20), Color.FromArgb(170, 80, 220) };
                int n = 0;
                foreach (object o in J.Arr(a, "boxes"))
                {
                    var d = o as Dict; if (d == null) continue;
                    var r = J.Arr(d, "rect"); if (r.Count != 4) continue;
                    int l = Convert.ToInt32(r[0]) - ox, t = Convert.ToInt32(r[1]) - oy, rr = Convert.ToInt32(r[2]) - ox, bb = Convert.ToInt32(r[3]) - oy;
                    string label = J.Str(d, "label", n.ToString());
                    Color c = palette[n % palette.Length]; n++;
                    using (var pen = new Pen(c, 2f)) g.DrawRectangle(pen, l, t, Math.Max(1, rr - l), Math.Max(1, bb - t));
                    var sz = g.MeasureString(label, font);
                    var tag = new RectangleF(l, Math.Max(0, t - sz.Height), sz.Width + 4, sz.Height);
                    using (var br = new SolidBrush(c)) g.FillRectangle(br, tag);
                    g.DrawString(label, font, Brushes.White, tag.X + 2, tag.Y);
                }
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(dst)));
                b.Save(dst, ImageFormat.Png);
                return J.O("path", dst, "boxes", n);
            }
        }

        public static Dict Pixel(Dict a)
        {
            using (var b = Load(J.Str(a, "src")))
            {
                int x = J.Int(a, "x", 0), y = J.Int(a, "y", 0);
                if (x < 0 || y < 0 || x >= b.Width || y >= b.Height) throw new ArgumentException("pixel outside image");
                Color c = b.GetPixel(x, y);
                return J.O("r", c.R, "g", c.G, "b", c.B, "hex", string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B));
            }
        }

        /// <summary>Average colour + most common colour in a rect (cheap "what colour is this control" probe).</summary>
        public static Dict Dominant(Dict a)
        {
            using (var b = Load(J.Str(a, "src")))
            {
                var rect = J.Arr(a, "rect");
                var r = rect.Count == 4 ? Rectangle.Intersect(new Rectangle(0, 0, b.Width, b.Height), new Rectangle(Convert.ToInt32(rect[0]), Convert.ToInt32(rect[1]), Convert.ToInt32(rect[2]), Convert.ToInt32(rect[3]))) : new Rectangle(0, 0, b.Width, b.Height);
                var counts = new Dictionary<int, int>(); long sr = 0, sg = 0, sb2 = 0, n = 0;
                int step = Math.Max(1, Math.Max(r.Width, r.Height) / 200);
                for (int y = r.Top; y < r.Bottom; y += step) for (int x = r.Left; x < r.Right; x += step)
                {
                    Color c = b.GetPixel(x, y); int k = c.ToArgb() & 0xFFFFFF; int cnt; counts.TryGetValue(k, out cnt); counts[k] = cnt + 1;
                    sr += c.R; sg += c.G; sb2 += c.B; n++;
                }
                if (n == 0) throw new ArgumentException("empty region");
                int best = 0, bestN = -1; foreach (var kv in counts) if (kv.Value > bestN) { bestN = kv.Value; best = kv.Key; }
                return J.O("dominant", string.Format("#{0:X6}", best), "average", string.Format("#{0:X2}{1:X2}{2:X2}", sr / n, sg / n, sb2 / n), "samples", n);
            }
        }
    }
}
