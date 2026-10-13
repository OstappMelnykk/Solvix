using System.Globalization;
using System.Text;

namespace Refinement3D.Tests;

/// <summary>Charts as plain SVG files, drawn from the numbers of the study (no libraries).</summary>
public static class Svg
{
    public sealed record Series(string Name, string Color, double[] Values);

    private static string N(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    private static string Esc(string s) => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    /// <summary>Bars grouped by category, one bar of each series in a group.</summary>
    public static void GroupedBars(string path, string title, string yLabel, string[] categories, Series[] series, double? yMax = null, bool log = false)
    {
        const int W = 960, H = 500, L = 70, R = 20, T = 56, B = 136;
        double max = yMax ?? series.SelectMany(s => s.Values).Max() * 1.12;
        if (max <= 0) max = 1;
        double Y(double v)
        {
            double t = log ? Math.Log10(Math.Max(v, 1)) / Math.Log10(Math.Max(max, 10)) : v / max;
            return T + (H - T - B) * (1 - Math.Clamp(t, 0, 1));
        }
        var sb = new StringBuilder();
        sb.AppendLine($"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {W} {H}\" font-family=\"system-ui, sans-serif\" font-size=\"12\">");
        sb.AppendLine($"<rect width=\"{W}\" height=\"{H}\" fill=\"#ffffff\"/>");
        sb.AppendLine($"<text x=\"{W / 2}\" y=\"26\" text-anchor=\"middle\" font-size=\"16\" font-weight=\"600\" fill=\"#222\">{Esc(title)}</text>");
        // grid and the scale
        int ticks = 5;
        for (int i = 0; i <= ticks; i++)
        {
            double v = log ? Math.Pow(10, Math.Log10(Math.Max(max, 10)) * i / ticks) : max * i / ticks;
            double y = Y(log && i == 0 ? 1 : v);
            sb.AppendLine($"<line x1=\"{L}\" x2=\"{W - R}\" y1=\"{N(y)}\" y2=\"{N(y)}\" stroke=\"#e3e3e3\"/>");
            sb.AppendLine($"<text x=\"{L - 8}\" y=\"{N(y + 4)}\" text-anchor=\"end\" fill=\"#555\">{(log ? N(Math.Round(v)) : N(v))}</text>");
        }
        sb.AppendLine($"<text transform=\"translate(16 {(T + H - B) / 2}) rotate(-90)\" text-anchor=\"middle\" fill=\"#555\">{Esc(yLabel)}</text>");
        double groupWidth = (W - L - R) / (double)categories.Length;
        double barWidth = Math.Min(34, groupWidth * 0.8 / series.Length);
        for (int c = 0; c < categories.Length; c++)
        {
            double x0 = L + c * groupWidth + (groupWidth - barWidth * series.Length) / 2;
            for (int s = 0; s < series.Length; s++)
            {
                double v = series[s].Values[c];
                double y = Y(v), h = Y(log ? 1 : 0) - y;
                sb.AppendLine($"<rect x=\"{N(x0 + s * barWidth)}\" y=\"{N(y)}\" width=\"{N(barWidth - 2)}\" height=\"{N(Math.Max(h, 0))}\" fill=\"{series[s].Color}\"/>");
                sb.AppendLine($"<text x=\"{N(x0 + s * barWidth + (barWidth - 2) / 2)}\" y=\"{N(y - 4)}\" text-anchor=\"middle\" font-size=\"10\" fill=\"#333\">{(v >= 100 ? N(Math.Round(v)) : v.ToString("0.##", CultureInfo.InvariantCulture))}</text>");
            }
            var words = categories[c].Split('\n');
            for (int w = 0; w < words.Length; w++)
                sb.AppendLine($"<text x=\"{N(L + c * groupWidth + groupWidth / 2)}\" y=\"{H - B + 18 + w * 14}\" text-anchor=\"middle\" fill=\"#333\">{Esc(words[w])}</text>");
        }
        sb.AppendLine($"<line x1=\"{L}\" x2=\"{W - R}\" y1=\"{N(Y(log ? 1 : 0))}\" y2=\"{N(Y(log ? 1 : 0))}\" stroke=\"#888\"/>");
        // legend (a second row when it does not fit)
        double lx = L;
        int row = 0;
        for (int s = 0; s < series.Length; s++)
        {
            double width = 28 + series[s].Name.Length * 6.6;
            if (lx + width > W - R) { lx = L; row++; }
            double ly = H - 34 + row * 18;
            sb.AppendLine($"<rect x=\"{N(lx)}\" y=\"{N(ly)}\" width=\"12\" height=\"12\" fill=\"{series[s].Color}\"/>");
            sb.AppendLine($"<text x=\"{N(lx + 18)}\" y=\"{N(ly + 10)}\" fill=\"#333\">{Esc(series[s].Name)}</text>");
            lx += width;
        }
        sb.AppendLine("</svg>");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, sb.ToString());
    }

    /// <summary>Lines over a shared list of x values (equally spaced on the picture, labelled).</summary>
    public static void Lines(string path, string title, string xLabel, string yLabel, string[] xs, Series[] series, bool log = false)
    {
        const int W = 960, H = 440, L = 80, R = 24, T = 56, B = 90;
        double max = series.SelectMany(s => s.Values).Max() * 1.1;
        double Ymap(double v)
        {
            double t = log ? Math.Log10(Math.Max(v, 1)) / Math.Log10(Math.Max(max, 10)) : v / max;
            return T + (H - T - B) * (1 - Math.Clamp(t, 0, 1));
        }
        var sb = new StringBuilder();
        sb.AppendLine($"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {W} {H}\" font-family=\"system-ui, sans-serif\" font-size=\"12\">");
        sb.AppendLine($"<rect width=\"{W}\" height=\"{H}\" fill=\"#ffffff\"/>");
        sb.AppendLine($"<text x=\"{W / 2}\" y=\"26\" text-anchor=\"middle\" font-size=\"16\" font-weight=\"600\" fill=\"#222\">{Esc(title)}</text>");
        int ticks = 5;
        for (int i = 0; i <= ticks; i++)
        {
            double v = log ? Math.Pow(10, Math.Log10(Math.Max(max, 10)) * i / ticks) : max * i / ticks;
            double y = Ymap(log && i == 0 ? 1 : v);
            sb.AppendLine($"<line x1=\"{L}\" x2=\"{W - R}\" y1=\"{N(y)}\" y2=\"{N(y)}\" stroke=\"#e3e3e3\"/>");
            sb.AppendLine($"<text x=\"{L - 8}\" y=\"{N(y + 4)}\" text-anchor=\"end\" fill=\"#555\">{N(Math.Round(v))}</text>");
        }
        sb.AppendLine($"<text transform=\"translate(16 {(T + H - B) / 2}) rotate(-90)\" text-anchor=\"middle\" fill=\"#555\">{Esc(yLabel)}</text>");
        sb.AppendLine($"<text x=\"{(L + W - R) / 2}\" y=\"{H - 44}\" text-anchor=\"middle\" fill=\"#555\">{Esc(xLabel)}</text>");
        double Xmap(int i) => L + (W - L - R) * (xs.Length == 1 ? 0.5 : (i + 0.5) / xs.Length);
        for (int i = 0; i < xs.Length; i++)
            sb.AppendLine($"<text x=\"{N(Xmap(i))}\" y=\"{H - B + 18}\" text-anchor=\"middle\" fill=\"#333\">{Esc(xs[i])}</text>");
        foreach (var s in series)
        {
            var points = string.Join(" ", s.Values.Select((v, i) => $"{N(Xmap(i))},{N(Ymap(v))}"));
            sb.AppendLine($"<polyline points=\"{points}\" fill=\"none\" stroke=\"{s.Color}\" stroke-width=\"2.5\"/>");
            for (int i = 0; i < s.Values.Length; i++)
                sb.AppendLine($"<circle cx=\"{N(Xmap(i))}\" cy=\"{N(Ymap(s.Values[i]))}\" r=\"4\" fill=\"{s.Color}\"/>");
        }
        double lx = L;
        foreach (var s in series)
        {
            sb.AppendLine($"<rect x=\"{N(lx)}\" y=\"{H - 28}\" width=\"12\" height=\"12\" fill=\"{s.Color}\"/>");
            sb.AppendLine($"<text x=\"{N(lx + 18)}\" y=\"{H - 18}\" fill=\"#333\">{Esc(s.Name)}</text>");
            lx += 28 + s.Name.Length * 6.6;
        }
        sb.AppendLine("</svg>");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, sb.ToString());
    }
}
