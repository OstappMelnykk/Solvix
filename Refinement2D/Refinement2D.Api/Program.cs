using System.Text.Json;
using Refinement2D.Core;

// A tiny API for looking at the 2D refinement: one mesh in memory, with undo. Nothing here is connected to Solvix.
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();
// the page is a separate project (refinement2d-web): in development it asks this API through its dev server's proxy

var session = new Session();

app.MapGet("/api/state", () => session.State());
app.MapPost("/api/grid", (GridRequest r) =>
{
    try { session.Reset(QuadMesh.Grid(r.Nx, r.Ny, r.Holes?.Select(h => (h[0], h[1])))); }
    catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/refine", (RefineRequest r) =>
{
    try { session.Refine(r.Cells, r.NI, r.NJ); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return Results.BadRequest(new { error = e.Message, state = session.State() }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/undo", () => { session.Undo(); return session.State(); });
app.MapPost("/api/redo", () => { session.Redo(); return session.State(); });

app.Run();

record GridRequest(int Nx, int Ny, int[][]? Holes);
record RefineRequest(int[] Cells, int NI, int NJ);

sealed class Session
{
    private QuadMesh _mesh = QuadMesh.Grid(8, 8);
    private readonly List<QuadMesh> _undo = new(), _redo = new();
    private RefineResult? _last;

    public void Reset(QuadMesh mesh) { _mesh = mesh; _undo.Clear(); _redo.Clear(); _last = null; }

    public void Refine(int[] cells, int nI, int nJ)
    {
        var next = _mesh.Clone();
        var result = Refiner.Refine(next, cells, nI, nJ);
        _undo.Add(_mesh);
        _redo.Clear();
        _mesh = next;
        _last = result;
    }

    public void Undo()
    {
        if (_undo.Count == 0) return;
        _redo.Add(_mesh);
        _mesh = _undo[^1];
        _undo.RemoveAt(_undo.Count - 1);
        _last = null;
    }

    public void Redo()
    {
        if (_redo.Count == 0) return;
        _undo.Add(_mesh);
        _mesh = _redo[^1];
        _redo.RemoveAt(_redo.Count - 1);
        _last = null;
    }

    public object State() => new
    {
        scale = _mesh.Scale,
        nodes = _mesh.Nodes.Select(p => new[] { p.X, p.Y }),
        cells = _mesh.Cells.Values.OrderBy(c => c.Id).Select(c => new { id = c.Id, nodes = c.Nodes, root = c.Root }),
        roots = _mesh.Roots.Select(r => new { id = r.Id, i = r.I, j = r.J }),
        problems = Conformity.Check(_mesh),
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
