using System.Diagnostics;
using System.Text;
using Refinement3D.Core;

namespace Refinement3D.Tests;

/// <summary>
/// The study behind docs/research/local-refinement-3d: every number in that report comes from here. Run it with
/// <c>dotnet test Refinement3D.Tests --filter Name=Study</c>; the tables are written to the file named by the environment variable STUDY_OUT
/// (by default study-output.md next to the test assembly) and to the test output.
/// </summary>
public class Study
{
    private readonly StringBuilder _out = new();
    private static string Img(string file) => Path.Combine(Environment.GetEnvironmentVariable("STUDY_IMG") ?? Path.Combine(AppContext.BaseDirectory, "img"), file);
    private readonly Dictionary<string, List<double>> _spread = new();                                   // "depth 0" -> roots touched for each cube position
    private readonly List<(string Scenario, Dictionary<string, (double Worst, double Mean, int Poor, int Inverted)> Methods)> _smooth = new();
    private double[] _seam = new double[2];
    private readonly List<(int Cells, long Refine, long Check, long Laplacian, long Optimization)> _scale = new();
    private readonly List<(string Name, double Plain, double Optimized, int Cells)> _widths = new();
    private void Line(string text = "") { _out.AppendLine(text); TestContext.Out.WriteLine(text); }

    [Test, Explicit("the study: takes a few minutes")]
    public void Run()
    {
        Spread();
        RefinementQuality();
        Smoothers();
        SeamSearch();
        Scale();
        Rounds();
        Charts();
        var path = Environment.GetEnvironmentVariable("STUDY_OUT") ?? Path.Combine(AppContext.BaseDirectory, "study-output.md");
        File.WriteAllText(path, _out.ToString());
        TestContext.Out.WriteLine("written to " + path);
    }

    // ---- F. how many refinements in a row the integer lattice holds ----------------------------------------------------------

    private void Rounds()
    {
        Line("### F. Скільки згущень поспіль витримує цілочисельна решітка (той самий кут кожного разу, сітка 3×3×3)");
        Line();
        Line("| n | згущень до відмови | вузлів у кінці | найбільша координата |");
        Line("|---|---|---|---|");
        foreach (int n in new[] { 2, 3, 4, 8 })
        {
            var mesh = HexMesh.Grid(3, 3, 3);
            int rounds = 0;
            while (rounds < 200)
            {
                var leaf = mesh.Cells.Values.Where(c => c.Nodes.Select(mesh.PointOf).Min(p => p.X + p.Y + p.Z) == 0).OrderBy(c => c.Nodes.Select(mesh.PointOf).Max(p => p.X + p.Y + p.Z)).First();
                try { Refiner.Refine(mesh, new[] { leaf.Id }, n, n, n, 0); rounds++; }
                catch (InvalidOperationException) { break; }
            }
            Line($"| {n} | {rounds}{(rounds == 200 ? "+ (зупинено)" : "")} | {mesh.Nodes.Count} | {mesh.Nodes.Max(p => Math.Max(p.X, Math.Max(p.Y, p.Z)))} (межа 2^40 = {1L << 40}) |");
        }
        Line();
    }

    private void Charts()
    {
        string[] positions = { "кутовий", "на ребрі\nсітки", "на грані\nсітки", "всередині" };
        Svg.GroupedBars(Img("spread.svg"), "Скільки кубів зачіпає згущення одного куба (n = 2, сітка 9×9×9)", "кубів зачеплено", positions,
            _spread.Select((kv, i) => new Svg.Series(kv.Key, new[] { "#4c9be8", "#f0a030", "#d0504a" }[i], kv.Value.ToArray())).ToArray());
        string[] names = { "без згладжування", "звичайне", "Лапласівка з перевіркою, нерухома поверхня", "Лапласівка з перевіркою + ковзання", "оптимізація (20 проходів) + ковзання", "Лапласівка 40 + оптимізація 20 + ковзання" };
        string[] shortNames = { "без згладжування", "звичайне (без перевірок)", "Лапласівка (з перевіркою)", "Лапласівка + ковзання", "оптимізація", "Лапласівка + оптимізація" };
        string[] colors = { "#b0b0b0", "#e0a0a0", "#8cb8e8", "#4c8be0", "#3aa860", "#1f7a40" };
        var scenarios = _smooth.Select(x => x.Scenario).ToArray();
        Svg.GroupedBars(Img("worst.svg"), "Найгірша клітинка після згладжування (скалярний якобіан, більше — краще)", "скал. якобіан найгіршої клітинки", scenarios,
            names.Select((n, i) => new Svg.Series(shortNames[i], colors[i], _smooth.Select(x => x.Methods[n].Worst).ToArray())).ToArray(), yMax: 0.7);
        Svg.GroupedBars(Img("poor.svg"), "Кількість поганих клітинок (скал. якобіан < 0,3) після згладжування (менше — краще)", "поганих клітинок (логарифмічна шкала)", scenarios,
            names.Select((n, i) => new Svg.Series(shortNames[i], colors[i], _smooth.Select(x => (double)x.Methods[n].Poor).ToArray())).ToArray(), log: true, yMax: 400);
        Svg.GroupedBars(Img("seam.svg"), "Частка позначених листків, розрізаних повністю", "відсотків", new[] { "вибір швів" },
            new[] { new Svg.Series("по одному, жадібно", "#e0a0a0", new[] { _seam[0] }), new Svg.Series("пошук з поверненням", "#3aa860", new[] { _seam[1] }) }, yMax: 110);
        Svg.GroupedBars(Img("widths.svg"), "Найгірша клітинка після згладжування залежно від ширини перехідної зони (куб 3×3×3 у сітці 5×5×5)", "скал. якобіан найгіршої клітинки",
            _widths.Select(w => w.Name).ToArray(), new[] { new Svg.Series("Лапласівка 40 проходів", "#4c8be0", _widths.Select(w => w.Plain).ToArray()), new Svg.Series("Лапласівка 20 + оптимізація 20", "#3aa860", _widths.Select(w => w.Optimized).ToArray()) }, yMax: 0.7);
        Svg.Lines(Img("scale.svg"), "Час на великих сітках (випадкові 4% кубів, n = 2)", "клітинок у результаті", "мілісекунд",
            _scale.Select(x => x.Cells.ToString()).ToArray(),
            new[] { new Svg.Series("згущення", "#3aa860", _scale.Select(x => (double)x.Refine).ToArray()), new Svg.Series("перевірка конформності", "#4c8be0", _scale.Select(x => (double)x.Check).ToArray()),
                    new Svg.Series("Лапласівка, 10 проходів", "#f0a030", _scale.Select(x => (double)x.Laplacian).ToArray()), new Svg.Series("оптимізація, 5 проходів", "#d0504a", _scale.Select(x => (double)x.Optimization).ToArray()) });
    }

    // ---- A. how far one refinement spreads ----------------------------------------------------------------------------------

    private void Spread()
    {
        Line("### A. Скільки кубів зачіпає згущення одного куба (сітка 9×9×9, n = 2×2×2)");
        Line();
        Line("| куб | ширина зони | кубів зачеплено | клітинок у результаті |");
        Line("|---|---|---|---|");
        foreach (var (name, at) in new[] { ("кутовий", (0, 0, 0)), ("на ребрі сітки", (4, 0, 0)), ("на грані сітки", (4, 4, 0)), ("всередині", (4, 4, 4)) })
            foreach (int depth in new[] { 0, 1, 2 })
            {
                var mesh = HexMesh.Grid(9, 9, 9);
                Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == at).Leaves.ToList(), 2, 2, 2, depth);
                Line($"| {name} | {depth}{(depth == 2 ? " (книга)" : "")} | {mesh.Roots.Count(r => r.Leaves.Count > 1)} | {mesh.Cells.Count} |");
                if (!_spread.TryGetValue($"ширина зони {depth}{(depth == 2 ? " (книга)" : "")}", out var list)) _spread[$"ширина зони {depth}{(depth == 2 ? " (книга)" : "")}"] = list = new();
                list.Add(mesh.Roots.Count(r => r.Leaves.Count > 1));
            }
        Line();
    }

    // ---- B. the quality of the refined mesh before any smoothing -------------------------------------------------------------

    private void RefinementQuality()
    {
        Line("### B. Якість сітки відразу після згущення (куб посередині сітки 5×5×5, до згладжування)");
        Line();
        Line("| n | ширина зони | клітинок | найгірша (скал. якобіан) | середня | погані (< 0,3) |");
        Line("|---|---|---|---|---|---|");
        foreach (int n in new[] { 2, 3, 4 })
            foreach (int depth in new[] { 0, 1, 2 })
            {
                var mesh = HexMesh.Grid(5, 5, 5);
                Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == (2, 2, 2)).Leaves.ToList(), n, n, n, depth);
                var q = Smoothing.QualityOf(mesh, Smoothing.Lattice(mesh));
                Line($"| {n} | {depth} | {mesh.Cells.Count} | {q.MinScaled:0.000} | {q.MeanScaled:0.000} | {q.Poor} |");
            }
        Line();
        foreach (int depth in new[] { 0, 1, 2 })
        {
            var mesh = HexMesh.Grid(5, 5, 5);
            Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == (2, 2, 2)).Leaves.ToList(), 3, 3, 3, depth);
            double plain = Smoothing.Smooth(mesh, new SmoothingOptions(40, 0.5, 0.5, true)).After.MinScaled;
            double optimized = Smoothing.Smooth(mesh, new SmoothingOptions(20, 0.5, 0.5, true, 20)).After.MinScaled;
            _widths.Add(($"ширина зони {depth}{(depth == 2 ? " (книга)" : "")}\n{mesh.Cells.Count} клітинок", plain, optimized, mesh.Cells.Count));
        }
    }

    // ---- C. smoothing methods compared ---------------------------------------------------------------------------------------

    // what is usually done: every node not on the surface goes to the plain average of its neighbours, the surface stays, nothing is checked
    private static (double[] Pos, long Ms) Naive(HexMesh mesh, int passes, double omega)
    {
        var sw = Stopwatch.StartNew();
        var pos = Smoothing.Lattice(mesh);
        var constraint = Smoothing.SurfaceConstraints(mesh);
        var neighbours = new HashSet<int>[mesh.Nodes.Count];
        for (int i = 0; i < neighbours.Length; i++) neighbours[i] = new HashSet<int>();
        foreach (var c in mesh.Cells.Values)
            for (int s = 0; s < 8; s++)
                for (int a = 0; a < 3; a++)
                    if (Hex.Bit(s, a) == 0) { neighbours[c.Nodes[s]].Add(c.Nodes[s | 1 << a]); neighbours[c.Nodes[s | 1 << a]].Add(c.Nodes[s]); }
        for (int it = 0; it < passes; it++)
        {
            var next = (double[])pos.Clone();
            for (int i = 0; i < neighbours.Length; i++)
            {
                if (constraint[i] != 0 || neighbours[i].Count == 0) continue;
                for (int a = 0; a < 3; a++) next[i * 3 + a] = pos[i * 3 + a] + omega * (neighbours[i].Average(j => pos[j * 3 + a]) - pos[i * 3 + a]);
            }
            pos = next;
        }
        return (pos, sw.ElapsedMilliseconds);
    }

    private void Smoothers()
    {
        Line("### C. Згладжування: порівняння методів (поверхня тіла скрізь збережена)");
        Line();
        Line("«Звичайне» — те, що роблять зазвичай: кожен внутрішній вузол іде до простого середнього сусідів, поверхня нерухома, нічого не перевіряється (20 проходів, крок 0,5). Усі інші методи — мої.");
        Line();
        var scenarios = new (string Name, Func<HexMesh> Make)[]
        {
            ("S1: куб посередині 5×5×5, n=3, зона 0", () => One(5, (2, 2, 2), 3, 0)),
            ("S2: той самий, зона 1", () => One(5, (2, 2, 2), 3, 1)),
            ("S3: той самий, зона 2 (книга)", () => One(5, (2, 2, 2), 3, 2)),
            ("S4: кутовий куб 5×5×5, n=3, зона 0", () => One(5, (0, 0, 0), 3, 0)),
            ("S5: блок 3×3×3 у сітці 7×7×7, n=2, зона 0", Block),
            ("S6: розкидані куби (5%) у сітці 8×8×8, n=2, зона 0", Scattered),
            ("S7: повторне згущення листків, сітка 5×5×5", Second)
        };
        foreach (var (name, make) in scenarios)
        {
            var mesh = make();
            var lattice = Smoothing.Lattice(mesh);
            double volume = Smoothing.TotalVolume(mesh, lattice);
            Line($"**{name}** — {mesh.Cells.Count} клітинок");
            Line();
            Line("| метод | найгірша | середня | погані | вивернуті | зміна об'єму | час, мс |");
            Line("|---|---|---|---|---|---|---|");
            var q0 = Smoothing.QualityOf(mesh, lattice);
            Line($"| без згладжування | {q0.MinScaled:0.000} | {q0.MeanScaled:0.000} | {q0.Poor} | {q0.Inverted} | 0 | 0 |");
            var methods = new Dictionary<string, (double, double, int, int)> { ["без згладжування"] = (q0.MinScaled, q0.MeanScaled, q0.Poor, q0.Inverted) };
            var (naive, naiveMs) = Naive(mesh, 20, 0.5);
            Row("звичайне (без перевірок)", mesh, naive, volume, naiveMs);
            var qn = Smoothing.QualityOf(mesh, naive); methods["звичайне"] = (qn.MinScaled, qn.MeanScaled, qn.Poor, qn.Inverted);
            foreach (var (label, options) in new (string, SmoothingOptions)[]
            {
                ("Лапласівка з перевіркою, нерухома поверхня", new SmoothingOptions(40, 0.5, 0.5, false)),
                ("Лапласівка з перевіркою + ковзання", new SmoothingOptions(40, 0.5, 0.5, true)),
                ("оптимізація (20 проходів) + ковзання", new SmoothingOptions(0, 0.5, 0.5, true, 20)),
                ("Лапласівка 40 + оптимізація 20 + ковзання", new SmoothingOptions(40, 0.5, 0.5, true, 20))
            })
            {
                var sw = Stopwatch.StartNew();
                var r = Smoothing.Smooth(mesh, options);
                Row(label, mesh, r.Positions, volume, sw.ElapsedMilliseconds);
                methods[label] = (r.After.MinScaled, r.After.MeanScaled, r.After.Poor, r.After.Inverted);
            }
            _smooth.Add((name.Split(':')[0], methods));
            Line();
        }
    }

    private void Row(string label, HexMesh mesh, double[] pos, double volume, long ms)
    {
        var q = Smoothing.QualityOf(mesh, pos);
        double dv = Smoothing.TotalVolume(mesh, pos) - volume;
        Line($"| {label} | {q.MinScaled:0.000} | {q.MeanScaled:0.000} | {q.Poor} | {q.Inverted} | {dv:0.0e+0} | {ms} |");
    }

    private static HexMesh One(int side, (int, int, int) at, int n, int depth)
    {
        var mesh = HexMesh.Grid(side, side, side);
        Refiner.Refine(mesh, mesh.Roots.Single(r => (r.I, r.J, r.K) == at).Leaves.ToList(), n, n, n, depth);
        return mesh;
    }

    private static HexMesh Block()
    {
        var mesh = HexMesh.Grid(7, 7, 7);
        Refiner.Refine(mesh, mesh.Roots.Where(r => r.I is >= 2 and < 5 && r.J is >= 2 and < 5 && r.K is >= 2 and < 5).SelectMany(r => r.Leaves).ToList(), 2, 2, 2, 0);
        return mesh;
    }

    private static HexMesh Scattered()
    {
        var random = new System.Random(3);
        var mesh = HexMesh.Grid(8, 8, 8);
        Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.05).SelectMany(r => r.Leaves).ToList(), 2, 2, 2, 0);
        return mesh;
    }

    private static HexMesh Second()
    {
        var random = new System.Random(4);
        var mesh = HexMesh.Grid(5, 5, 5);
        Refiner.Refine(mesh, mesh.Roots.Where(r => r.I is >= 1 and < 4 && r.J is >= 1 and < 4 && r.K is >= 1 and < 4).SelectMany(r => r.Leaves).ToList(), 2, 2, 2, 0);
        var leaves = mesh.Cells.Keys.Where(_ => random.NextDouble() < 0.04).ToList();
        Refiner.Refine(mesh, leaves, 2, 2, 2, 0);
        return mesh;
    }

    // ---- D. the search for the seams of the cells of M ----------------------------------------------------------------------

    private void SeamSearch()
    {
        Line("### D. Скільки позначених листків ділиться повністю (n = 2…3, листки попереднього згущення)");
        Line();
        Line("| вибір швів | листків перевірено | розрізано повністю | частка |");
        Line("|---|---|---|---|");
        foreach (bool search in new[] { false, true })
        {
            SeamSolver.SearchEnabled = search;
            try
            {
                var random = new System.Random(5);
                int total = 0, whole = 0;
                for (int trial = 0; trial < 150; trial++)
                {
                    var mesh = HexMesh.Grid(3, 3, 3);
                    Refiner.Refine(mesh, mesh.Roots.Where(_ => random.NextDouble() < 0.3).SelectMany(r => r.Leaves).ToList(), 2, 2, 2);
                    var boxes = mesh.Cells.Values.Where(c => IsBox(mesh, c)).Select(c => c.Id).Where(_ => random.NextDouble() < 0.06).ToList();
                    if (boxes.Count == 0) continue;
                    long before = mesh.Scale;
                    var regions = boxes.Select(id => BoxOf(mesh, mesh.Cells[id])).ToList();
                    int nI = random.Next(2, 4), nJ = random.Next(2, 4), nK = random.Next(2, 4);
                    Refiner.Refine(mesh, boxes, nI, nJ, nK);
                    long f = mesh.Scale / before;
                    foreach (var b in regions)
                    {
                        total++;
                        var (x0, y0, z0, x1, y1, z1) = (b.X0 * f, b.Y0 * f, b.Z0 * f, b.X1 * f, b.Y1 * f, b.Z1 * f);
                        var pieces = mesh.Cells.Values.Where(c => IsBox(mesh, c)).Select(c => BoxOf(mesh, c)).Where(q => q.X0 >= x0 && q.X1 <= x1 && q.Y0 >= y0 && q.Y1 <= y1 && q.Z0 >= z0 && q.Z1 <= z1).ToList();
                        if (pieces.Count == nI * nJ * nK && pieces.Sum(q => (q.X1 - q.X0) * (q.Y1 - q.Y0) * (q.Z1 - q.Z0)) == (x1 - x0) * (y1 - y0) * (z1 - z0)) whole++;
                    }
                }
                Line($"| {(search ? "пошук з поверненням (мій)" : "по одному, жадібно")} | {total} | {whole} | {100.0 * whole / total:0.0}% |");
                _seam[search ? 1 : 0] = 100.0 * whole / total;
            }
            finally { SeamSolver.SearchEnabled = true; }
        }
        Line();
    }

    private static bool IsBox(HexMesh mesh, Cell c)
    {
        var p = mesh.CornersOf(c);
        for (int s = 0; s < 8; s++)
            for (int axis = 0; axis < 3; axis++)
            {
                var q = p[s ^ (1 << axis)];
                for (int other = 0; other < 3; other++) if (other != axis && q[other] != p[s][other]) return false;
            }
        return true;
    }

    private static (long X0, long Y0, long Z0, long X1, long Y1, long Z1) BoxOf(HexMesh mesh, Cell c)
    {
        var p = mesh.CornersOf(c);
        return (p.Min(q => q.X), p.Min(q => q.Y), p.Min(q => q.Z), p.Max(q => q.X), p.Max(q => q.Y), p.Max(q => q.Z));
    }

    // ---- E. speed on big meshes ---------------------------------------------------------------------------------------------

    private void Scale()
    {
        Line("### E. Швидкість на великих сітках (випадкові 4% кубів, n = 2×2×2, ширина зони 0)");
        Line();
        Line("| сітка | кубів обрано | клітинок у результаті | згущення, мс | перевірка конформності, мс | Лапласівка 10 проходів, мс | оптимізація 5 проходів, мс |");
        Line("|---|---|---|---|---|---|---|");
        Smoothing.Smooth(HexMesh.Grid(2, 2, 2), new SmoothingOptions(1));                         // warm up the JIT
        foreach (int side in new[] { 8, 12, 16, 20 })
        {
            var random = new System.Random(1);
            var mesh = HexMesh.Grid(side, side, side);
            var chosen = mesh.Roots.Where(_ => random.NextDouble() < 0.04).SelectMany(r => r.Leaves).ToList();
            var sw = Stopwatch.StartNew();
            Refiner.Refine(mesh, chosen, 2, 2, 2, 0);
            long tRefine = sw.ElapsedMilliseconds; sw.Restart();
            var problems = Conformity.Check(mesh);
            long tCheck = sw.ElapsedMilliseconds; sw.Restart();
            Smoothing.Smooth(mesh, new SmoothingOptions(10, 0.5, 0.5, true));
            long tLap = sw.ElapsedMilliseconds; sw.Restart();
            Smoothing.Smooth(mesh, new SmoothingOptions(0, 0.5, 0.5, true, 5));
            long tOpt = sw.ElapsedMilliseconds;
            Line($"| {side}³ | {chosen.Count} | {mesh.Cells.Count} | {tRefine} | {tCheck} ({problems.Count} проблем) | {tLap} | {tOpt} |");
            _scale.Add((mesh.Cells.Count, tRefine, tCheck, tLap, tOpt));
        }
        Line();
        Line("Суцільні блоки:");
        Line();
        Line("| сітка | блок | n | ширина зони | клітинок | згущення, мс | перевірка, мс | не розрізано до кінця |");
        Line("|---|---|---|---|---|---|---|---|");
        foreach (var (side, block, n, depth) in new[] { (12, 6, 2, 0), (12, 6, 3, 0), (16, 8, 2, 0), (16, 6, 3, 1), (12, 4, 2, 2) })
        {
            var mesh = HexMesh.Grid(side, side, side);
            int lo = (side - block) / 2;
            var chosen = mesh.Roots.Where(r => r.I >= lo && r.I < lo + block && r.J >= lo && r.J < lo + block && r.K >= lo && r.K < lo + block).SelectMany(r => r.Leaves).ToList();
            var sw = Stopwatch.StartNew();
            var result = Refiner.Refine(mesh, chosen, n, n, n, depth);
            long t = sw.ElapsedMilliseconds; sw.Restart();
            var problems = Conformity.Check(mesh);
            Line($"| {side}³ | {block}³ ({chosen.Count}) | {n} | {depth} | {mesh.Cells.Count} | {t} | {sw.ElapsedMilliseconds} ({problems.Count} проблем) | {result.Passes.Sum(p => p.Unreached.Count)} |");
        }
        Line();
    }
}
