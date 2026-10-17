using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class ShellExportTests
{
    private static HexMeshEditor Body(string kind, IReadOnlyDictionary<string, double>? values = null)
    {
        var editor = new HexMeshEditor();
        var result = editor.AddTemplateBody(HexTemplates.Kind(kind).Build(values));
        Assert.That(result.Ok, Is.True, result.Error);
        return editor;
    }

    private static (long, long, long) Key(Vec3 p) => ((long)Math.Round(p.X * 1e6), (long)Math.Round(p.Y * 1e6), (long)Math.Round(p.Z * 1e6));

    /// <summary>Every directed edge must be met once and its reverse once: a closed skin whose triangles agree on which way is out.</summary>
    private static void AssertClosedAndConsistent(ShellMesh shell)
    {
        var directed = new Dictionary<((long, long, long), (long, long, long)), int>();
        void Count((long, long, long) a, (long, long, long) b) => directed[(a, b)] = directed.GetValueOrDefault((a, b)) + 1;
        foreach (var (a, b, c) in shell.Triangles)
        {
            var (ka, kb, kc) = (Key(a), Key(b), Key(c));
            Count(ka, kb); Count(kb, kc); Count(kc, ka);
        }
        foreach (var ((a, b), times) in directed)
        {
            Assert.That(times, Is.EqualTo(1), $"edge {a}->{b} is used {times} times");
            Assert.That(directed.ContainsKey((b, a)), Is.True, $"edge {a}->{b} has no partner");
        }
    }

    private static double Volume(ShellMesh shell) =>
        shell.Triangles.Sum(t => (t.A.X * (t.B.Y * t.C.Z - t.B.Z * t.C.Y) - t.A.Y * (t.B.X * t.C.Z - t.B.Z * t.C.X) + t.A.Z * (t.B.X * t.C.Y - t.B.Y * t.C.X)) / 6.0);

    [Test]
    public void A_single_cube_gives_six_faces_of_n_squared_squares_and_its_volume()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var shell = ShellExport.Build(editor.Mesh, 4);

        Assert.That(shell.Faces, Is.EqualTo(6));
        Assert.That(shell.Triangles, Has.Count.EqualTo(6 * 4 * 4 * 2));
        Assert.That(Volume(shell), Is.EqualTo(1.0).Within(1e-9));
        Assert.That(shell.MaxDeviation, Is.LessThan(1e-12));            // flat faces are exact
        AssertClosedAndConsistent(shell);
    }

    [Test]
    public void A_pipe_is_a_closed_skin_without_the_inner_faces_between_its_cubes()
    {
        var editor = Body("pipe");
        var shell = ShellExport.Build(editor.Mesh, 3);

        Assert.That(shell.Faces, Is.LessThan(6 * editor.Mesh.Hexes.Count));
        Assert.That(Volume(shell), Is.GreaterThan(0));
        AssertClosedAndConsistent(shell);
    }

    [Test]
    public void Every_template_gives_a_closed_skin()
    {
        foreach (var preset in HexTemplates.Presets.Take(12))
        {
            var editor = Body(preset.Kind, preset.Values);
            var shell = ShellExport.Build(editor.Mesh, 2);
            Assert.That(shell.Triangles, Is.Not.Empty, preset.Name);
            AssertClosedAndConsistent(shell);
        }
    }

    [Test]
    public void A_curved_edge_makes_the_flat_triangles_stray_and_a_finer_grid_brings_them_back()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var hex = editor.Mesh.Hex(0);
        var mid = editor.Mesh.Node(hex.NodeIds[8]);                       // midpoint of the edge 0-1, pushed out of line
        editor.Mesh.SetNodePosition(mid.Id, mid.Position + new Vec3(0, -0.15, 0));

        double coarse = ShellExport.Build(editor.Mesh, 2).MaxDeviation;
        double fine = ShellExport.Build(editor.Mesh, 8).MaxDeviation;

        Assert.That(coarse, Is.GreaterThan(1e-4));
        Assert.That(fine, Is.LessThan(coarse / 8));
        AssertClosedAndConsistent(ShellExport.Build(editor.Mesh, 5));
    }

    [Test]
    public void The_stl_has_the_header_the_count_and_fifty_bytes_a_triangle()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var shell = ShellExport.Build(editor.Mesh, 2);
        var stl = ShellExport.ToBinaryStl(shell);

        Assert.That(stl, Has.Length.EqualTo(84 + 50 * shell.Triangles.Count));
        Assert.That(BitConverter.ToUInt32(stl, 80), Is.EqualTo((uint)shell.Triangles.Count));
    }

    [Test]
    public void A_density_out_of_range_is_refused()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        Assert.That(() => ShellExport.Build(editor.Mesh, 0), Throws.InstanceOf<ArgumentOutOfRangeException>());
        Assert.That(() => ShellExport.Build(editor.Mesh, ShellExport.MaxDensity + 1), Throws.InstanceOf<ArgumentOutOfRangeException>());
    }
}
