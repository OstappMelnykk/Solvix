using System.Text.Json;
using Refinement3D.Core;

// A tiny API for looking at the 3D refinement: one mesh in memory, with undo. Nothing here is connected to Solvix.
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);
var app = builder.Build();
// the page is a separate project (refinement3d-web): in development it asks this API through its dev server's proxy

var session = new Session();

app.MapGet("/api/state", () => session.State());
app.MapPost("/api/grid", (GridRequest r) =>
{
    try { session.Reset(HexMesh.Grid(r.Nx, r.Ny, r.Nz, r.Holes?.Select(h => (h[0], h[1], h[2])))); }
    catch (ArgumentException e) { return Results.BadRequest(new { error = e.Message }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/refine", (RefineRequest r) =>
{
    try { session.Refine(r.Cells, r.NI, r.NJ, r.NK); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return Results.BadRequest(new { error = e.Message, state = session.State() }); }
    return Results.Ok(session.State());
});
app.MapPost("/api/preview", (RefineRequest r) =>
{
    try { return Results.Ok(new { steps = session.Preview(r.Cells, r.NI, r.NJ, r.NK) }); }
    catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return Results.BadRequest(new { error = e.Message }); }
});
app.MapPost("/api/undo", () => { session.Undo(); return session.State(); });
app.MapPost("/api/redo", () => { session.Redo(); return session.State(); });

app.Run();

record GridRequest(int Nx, int Ny, int Nz, int[][]? Holes);
record RefineRequest(int[] Cells, int NI, int NJ, int NK);

sealed class Session
{
    private HexMesh _mesh = HexMesh.Grid(4, 4, 4);
    private readonly List<HexMesh> _undo = new(), _redo = new();
    private RefineResult? _last;

    public void Reset(HexMesh mesh) { _mesh = mesh; _undo.Clear(); _redo.Clear(); _last = null; }

    public void Refine(int[] cells, int nI, int nJ, int nK)
    {
        var next = _mesh.Clone();
        var result = Refiner.Refine(next, cells, nI, nJ, nK);
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

    // the refinement of the current mesh, stage by stage, without changing it: what the page's wizard steps through
    public object[] Preview(int[] cells, int nI, int nJ, int nK) =>
        Refiner.Preview(_mesh, cells, nI, nJ, nK).Select(step => (object)new
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

    private static object MeshOf(HexMesh mesh) => new
    {
        scale = mesh.Scale,
        nodes = mesh.Nodes.Select(p => new[] { p.X, p.Y, p.Z }),
        cells = mesh.Cells.Values.OrderBy(c => c.Id).Select(c => new { id = c.Id, nodes = c.Nodes, root = c.Root }),
        roots = mesh.Roots.Select(r => new { id = r.Id, i = r.I, j = r.J, k = r.K }),
        problems = Conformity.Check(mesh)
    };

    public object State() => new
    {
        scale = _mesh.Scale,
        nodes = _mesh.Nodes.Select(p => new[] { p.X, p.Y, p.Z }),
        cells = _mesh.Cells.Values.OrderBy(c => c.Id).Select(c => new { id = c.Id, nodes = c.Nodes, root = c.Root }),
        roots = _mesh.Roots.Select(r => new { id = r.Id, i = r.I, j = r.J, k = r.K }),
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
