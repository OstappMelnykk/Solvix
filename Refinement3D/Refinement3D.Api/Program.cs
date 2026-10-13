using System.Text.Json;
using Refinement3D.Core;

// A tiny API for looking at the 3D refinement: one mesh in memory, with undo. Nothing here is connected to Solvix.
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();
// the page is a separate project (refinement3d-web): in development it asks this API through its dev server's proxy

var session = new Session();

app.MapGet("/", () => Results.Text("Refinement3D.Api: this is the API (/api/...). The page is the Vite project refinement3d-web: http://localhost:5174"));
app.MapGet("/api/state", () => session.State());
app.MapPost("/api/grid", (GridRequest r) =>
{
    try { session.Reset(HexMesh.Grid(r.Nx, r.Ny, r.Nz, r.Holes?.Select(h => (h[0], h[1], h[2])))); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return Results.BadRequest(new { error = e.Message }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/refine", (RefineRequest r) =>
{
    try { session.Refine(r.Cells, r.NI, r.NJ, r.NK, r.TransitionDepth); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException or ArithmeticException) { return Results.BadRequest(new { error = e.Message, state = session.State() }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/preview", (RefineRequest r) =>
{
    try { return Results.Ok(new { steps = session.Preview(r.Cells, r.NI, r.NJ, r.NK, r.TransitionDepth) }); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException or ArithmeticException) { return Results.BadRequest(new { error = e.Message }); }
});
// one cube divided by one template, for looking at what the template does inside: kind T1 (a corner marked), T2 (an edge), T4 (a face)
app.MapGet("/api/template", (string kind, int n) =>
{
    if (n < 2 || n > 8) return Results.BadRequest(new { error = "n must be from 2 to 8." });
    int mask = kind switch
    {
        "T1" => 1,                                              // the corner (-, -, -)
        "T2" => 1 | 2,                                          // the edge from (-, -, -) to (+, -, -), along x
        "T4" => Hex.FaceMask(0, 0),                             // the face on the minus side of x
        _ => 0
    };
    if (mask == 0) return Results.BadRequest(new { error = "kind must be T1, T2 or T4." });
    var mesh = HexMesh.Grid(1, 1, 1);
    mesh.Rescale(n);
    var parent = mesh.Cells.Values.Single();
    var corners = mesh.CornersOf(parent);
    var marked = Patterns.SlotsOf(mask).Select(slot => parent.Nodes[slot]).ToList();
    var children = Templates.ChildrenFor(corners, mask, n)!;
    mesh.RemoveCell(parent.Id);
    foreach (var c in children) mesh.AddToRoot(mesh.AddCell(0, c));
    return Results.Ok(new { mesh = Session.MeshOf(mesh), marked, children = children.Count });
});
app.MapPost("/api/smooth", (SmoothRequest r) =>
{
    try { if (!session.StartSmoothing(new SmoothingOptions(r.Iterations, r.Relaxation, r.Density, r.Slide, r.OptimizationPasses), r.Continue)) return Results.Conflict(new { error = "Smoothing is already running." }); }
    catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    return Results.Ok(session.Progress(-1));
});
// what the smoothing has done so far (it runs in the background): the pass it is at, and, when there is something newer than version `since`, the positions and the quality
app.MapGet("/api/smooth/progress", (int since) => session.Progress(since));
app.MapPost("/api/smooth/cancel", () => { session.CancelSmoothing(); return session.Progress(-1); });
app.MapPost("/api/unsmooth", () => Busy(() => session.Unsmooth()));
app.MapPost("/api/undo", () => Busy(() => session.Undo()));
app.MapPost("/api/redo", () => Busy(() => session.Redo()));

// an action that changes the mesh is refused while the smoothing runs (the answer says so)
IResult Busy(Action action)
{
    try { action(); }
    catch (InvalidOperationException e) { return Results.Conflict(new { error = e.Message, state = session.State() }); }
    return Results.Ok(session.State());
}

app.Run();

record GridRequest(int Nx, int Ny, int Nz, int[][]? Holes);
record SmoothRequest(int Iterations = 20, double Relaxation = 0.5, double Density = 0.5, bool Slide = true, int OptimizationPasses = 0, bool Continue = false);
record RefineRequest(int[] Cells, int NI, int NJ, int NK, int TransitionDepth = 0);

sealed class Session
{
    private HexMesh _mesh = HexMesh.Grid(5, 5, 5);
    private readonly List<HexMesh> _undo = new(), _redo = new();
    private RefineResult? _last;
    private SmoothingResult? _smoothed;                     // the positions after smoothing (the lattice stays as it was); dropped by anything that changes the mesh

    public void Reset(HexMesh mesh) { EnsureNotSmoothing(); _mesh = mesh; _undo.Clear(); _redo.Clear(); _last = null; _smoothed = null; }

    // ---- smoothing in the background -------------------------------------------------------------------------------------

    private readonly object _lock = new();
    private CancellationTokenSource? _cancel;
    private bool _running;
    private int _pass, _passes, _version;
    private double[]? _snapshot;
    private Quality? _snapshotQuality, _qualityBefore;
    private string? _smoothError;

    private void EnsureNotSmoothing() { lock (_lock) if (_running) throw new InvalidOperationException("Smoothing is running: wait for it or stop it."); }

    public bool StartSmoothing(SmoothingOptions options, bool continueFromCurrent)
    {
        lock (_lock)
        {
            if (_running) return false;
            if (options.Iterations < 0 || options.OptimizationPasses < 0 || options.Relaxation <= 0 || options.Relaxation > 1 || options.Density < 0 || options.Density > 1) throw new ArgumentException("iterations >= 0, 0 < relaxation <= 1, 0 <= density <= 1.");
            _running = true;
            _pass = 0;
            _passes = options.Iterations + options.OptimizationPasses;
            _snapshot = null;
            _snapshotQuality = null;
            _smoothError = null;
            _version++;
            _cancel = new CancellationTokenSource();
        }
        var mesh = _mesh;
        var from = continueFromCurrent ? _smoothed?.Positions : null;                // the result of the last smoothing, or the lattice
        var token = _cancel.Token;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        Task.Run(() =>
        {
            try
            {
                var before = Smoothing.QualityOf(mesh, Smoothing.Lattice(mesh));
                lock (_lock) _qualityBefore = before;
                var result = Smoothing.Smooth(mesh, options, (pass, pos) =>
                {
                    bool show = clock.ElapsedMilliseconds >= 80 || pass == options.Iterations + options.OptimizationPasses;
                    var copy = show ? (double[])pos.Clone() : null;
                    var q = show ? Smoothing.QualityOf(mesh, pos) : null;
                    lock (_lock)
                    {
                        _pass = pass;
                        if (copy == null) return;
                        _snapshot = copy;
                        _snapshotQuality = q;
                        _version++;
                    }
                    clock.Restart();
                }, token, from);
                lock (_lock) { _smoothed = result; _snapshot = result.Positions; _snapshotQuality = result.After; _version++; }
            }
            catch (Exception e) { lock (_lock) _smoothError = e.Message; }
            finally { lock (_lock) { _running = false; _version++; } }
        });
        return true;
    }

    public void CancelSmoothing() { lock (_lock) _cancel?.Cancel(); }

    public object Progress(int since)
    {
        lock (_lock)
        {
            bool news = _snapshot != null && _version > since;
            return new
            {
                running = _running,
                pass = _pass,
                passes = _passes,
                version = _version,
                error = _smoothError,
                positions = news ? _snapshot : null,
                quality = news && _snapshotQuality != null ? QualityDto(_snapshotQuality) : null,
                qualityBefore = _qualityBefore == null ? null : QualityDto(_qualityBefore)
            };
        }
    }

    public void Unsmooth() { EnsureNotSmoothing(); _smoothed = null; }

    public void Refine(int[] cells, int nI, int nJ, int nK, int transitionDepth)
    {
        EnsureNotSmoothing();
        var next = _mesh.Clone();
        var result = Refiner.Refine(next, cells, nI, nJ, nK, transitionDepth);
        _undo.Add(_mesh);
        _redo.Clear();
        _mesh = next;
        _last = result;
        _smoothed = null;
    }

    public void Undo()
    {
        EnsureNotSmoothing();
        if (_undo.Count == 0) return;
        _redo.Add(_mesh);
        _mesh = _undo[^1];
        _undo.RemoveAt(_undo.Count - 1);
        _last = null;
        _smoothed = null;
    }

    public void Redo()
    {
        EnsureNotSmoothing();
        if (_redo.Count == 0) return;
        _undo.Add(_mesh);
        _mesh = _redo[^1];
        _redo.RemoveAt(_redo.Count - 1);
        _last = null;
        _smoothed = null;
    }

    // the refinement of the current mesh, stage by stage, without changing it: what the page's wizard steps through
    public object[] Preview(int[] cells, int nI, int nJ, int nK, int transitionDepth) =>
        Refiner.Preview(_mesh, cells, nI, nJ, nK, transitionDepth).Select(step => (object)new
        {
            kind = step.Kind,
            axis = step.Axis,
            n = step.N,
            mesh = step.Mesh is null ? null : MeshOf(step.Mesh),
            marked = step.Marked,
            m = step.M,
            applied = step.Applied.Select(a => new { cell = a.Cell, template = a.Template, index = a.Index, children = a.Children }),
            unreached = step.Unreached,
            seam = step.Try is null ? null : new { cell = step.Try.Cell, side = step.Try.Side, kind = step.Try.Kind, faceNodes = step.Try.FaceNodes, added = step.Try.Added, cutAcross = step.Try.CutAcross, uncut = step.Try.Uncut }
        }).ToArray();

    public static object MeshOf(HexMesh mesh) => new
    {
        scale = mesh.Scale,
        nodes = mesh.Nodes.Select(p => new[] { p.X, p.Y, p.Z }),
        cells = mesh.Cells.Values.OrderBy(c => c.Id).Select(c => new { id = c.Id, nodes = c.Nodes, root = c.Root }),
        roots = mesh.Roots.Select(r => new { id = r.Id, i = r.I, j = r.J, k = r.K }),
        problems = Conformity.Check(mesh)
    };

    private static object QualityDto(Quality q) => new { min = q.Min, mean = q.Mean, poor = q.Poor, inverted = q.Inverted, cells = q.Cells, minScaled = q.MinScaled, meanScaled = q.MeanScaled };

    public object State() => new
    {
        scale = _mesh.Scale,
        nodes = _mesh.Nodes.Select(p => new[] { p.X, p.Y, p.Z }),
        cells = _mesh.Cells.Values.OrderBy(c => c.Id).Select(c => new { id = c.Id, nodes = c.Nodes, root = c.Root }),
        roots = _mesh.Roots.Select(r => new { id = r.Id, i = r.I, j = r.J, k = r.K }),
        problems = Conformity.Check(_mesh),
        positions = _smoothed?.Positions,
        quality = QualityDto(_smoothed?.After ?? Smoothing.QualityOf(_mesh, Smoothing.Lattice(_mesh))),
        qualityBefore = _smoothed is null ? null : QualityDto(_smoothed.Before),
        smoothed = _smoothed is null ? null : new { moved = _smoothed.Moved },
        canUndo = _undo.Count > 0,
        canRedo = _redo.Count > 0,
        passes = _last?.Passes.Select(p => new
        {
            axis = p.Axis,
            n = p.N,
            marked = p.MarkedNodes,
            unreached = p.Unreached,
            applied = p.Applied.Select(a => new { cell = a.Cell, template = a.Template, index = a.Index, children = a.Children })
        })
    };
}
