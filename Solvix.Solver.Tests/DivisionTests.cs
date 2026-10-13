using Solvix.Contracts.Facades;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

public class DivisionTests
{
    private const int Session = 1;

    // ---- the setting -------------------------------------------------------------------------------

    [Test]
    public void Cubes_are_not_divided_until_asked()
    {
        Assert.That(NewFacade().GetSetup(Session).Divisions, Is.EqualTo(new[] { 1, 1, 1 }));
    }

    [Test]
    public void The_divisions_are_set_per_axis_and_out_of_range_values_change_nothing()
    {
        var facade = NewFacade();

        Assert.That(facade.SetDivisions(Session, 2, 3, 4).Divisions, Is.EqualTo(new[] { 2, 3, 4 }));
        int version = facade.GetSetup(Session).Version;
        foreach (var (x, y, z) in new[] { (0, 1, 1), (1, 9, 1), (1, 1, -1), (1, 1, 100) })
            Assert.That(facade.SetDivisions(Session, x, y, z).Divisions, Is.EqualTo(new[] { 2, 3, 4 }));
        Assert.That(facade.GetSetup(Session).Version, Is.EqualTo(version));
    }

    [Test]
    public void Clearing_the_setup_keeps_the_division()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);

        Assert.That(facade.ClearSetup(Session).Divisions, Is.EqualTo(new[] { 2, 2, 2 }));
    }

    // ---- the mesh ---------------------------------------------------------------------------------

    [TestCase(1, 1, 1, 20, 1)]
    [TestCase(2, 2, 2, 81, 8)]
    [TestCase(3, 3, 3, 208, 27)]
    [TestCase(2, 1, 3, 70, 6)]
    public void A_cube_is_cut_into_small_elements_with_the_solvers_node_count(int nx, int ny, int nz, int nodes, int elements)
    {
        var fine = FineMesh.Build(Export(Bar(1)), nx, ny, nz);

        Assert.That(fine.NodeCount, Is.EqualTo(nodes));
        Assert.That(fine.ElementCount, Is.EqualTo(elements));
    }

    [Test]
    public void The_fine_nodes_lie_on_the_cubes_shape_function_map_also_when_it_is_bent()
    {
        var editor = Bar(1);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[6], new Vec3(1.7, 1.4, 1.2), false);
        editor.MoveNode(editor.Mesh.Hex(0).NodeIds[10], new Vec3(0.5, 1.3, 0.1), false);
        var hex = editor.Mesh.Hex(0);
        var fine = FineMesh.Build(Export(editor), 3, 2, 4);

        var points = FineMesh.GridPoints(3, 2, 4);
        for (int i = 0; i < points.Length; i++)
        {
            int node = fine.GridNodes[i];
            var expected = hex.Map(new Vec3(points[i].X / 3.0 - 1, points[i].Y / 2.0 - 1, points[i].Z / 4.0 - 1));
            Assert.That(fine.Positions[node, 0], Is.EqualTo(expected.X).Within(1e-12));
            Assert.That(fine.Positions[node, 1], Is.EqualTo(expected.Y).Within(1e-12));
            Assert.That(fine.Positions[node, 2], Is.EqualTo(expected.Z).Within(1e-12));
        }
    }

    [Test]
    public void Linked_cubes_share_the_nodes_of_their_common_face_so_the_mesh_stays_whole()
    {
        var fine = FineMesh.Build(Export(Bar(2)), 2, 2, 2);

        // 2 * 81 nodes, minus the 21 on the shared face (a 5x5 face grid keeps the points with at most one odd index)
        Assert.That(fine.NodeCount, Is.EqualTo(2 * 81 - 21));
        // small elements on the two sides of the face use the very same nodes
        var left = fine.Connectivity;
        var onFace = Enumerable.Range(0, fine.ElementCount).Where(e => fine.ParentOf[e] == 0 && fine.Ex[e] == 1).SelectMany(e => Enumerable.Range(0, 20).Select(k => left[e, k]))
            .Intersect(Enumerable.Range(0, fine.ElementCount).Where(e => fine.ParentOf[e] == 1 && fine.Ex[e] == 0).SelectMany(e => Enumerable.Range(0, 20).Select(k => left[e, k])));
        Assert.That(onFace.Count(), Is.EqualTo(21));
    }

    [Test]
    public void Cubes_that_merely_touch_without_a_link_keep_separate_nodes()
    {
        var editor = Bar(2);
        editor.UnlinkFace(0, HexFace.XPlus);

        var fine = FineMesh.Build(Export(editor), 2, 2, 2);

        Assert.That(fine.NodeCount, Is.EqualTo(2 * 81));
    }

    [Test]
    public void A_chain_of_cubes_shares_every_interface()
    {
        var fine = FineMesh.Build(Export(Bar(4)), 2, 1, 1);

        // per cube (2,1,1): 5*3*3 grid points with at most one odd index = 5*9=45 minus the ones with >1 odd -> compute from the points list
        int perCube = FineMesh.GridPoints(2, 1, 1).Length;
        int sharedFace = FineMesh.GridPoints(2, 1, 1).Count(p => p.X == 0);
        Assert.That(fine.NodeCount, Is.EqualTo(4 * perCube - 3 * sharedFace));
    }

    [Test]
    public void A_pipe_stays_one_mesh_all_the_way_round()
    {
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("pipe").Build(new Dictionary<string, double> { ["around"] = 6, ["along"] = 2 }));
        var mesh = Export(editor);

        var fine = FineMesh.Build(mesh, 2, 2, 2);

        // count distinct nodes two ways: through the mesh itself, and from the parent count: every parent node gives exactly one fine node
        Assert.That(fine.NodeCount, Is.GreaterThan(mesh.NodeCount));
        var parentNodes = new HashSet<int>(mesh.Connectivity);
        Assert.That(parentNodes.Count, Is.EqualTo(mesh.NodeCount));
        // the cubes are all connected through shared fine nodes
        var cubesOfNode = new Dictionary<int, List<int>>();
        for (int e = 0; e < fine.ElementCount; e++)
            for (int k = 0; k < 20; k++)
                (cubesOfNode.TryGetValue(fine.Connectivity[e, k], out var l) ? l : cubesOfNode[fine.Connectivity[e, k]] = new()).Add(fine.ParentOf[e]);
        var parent = Enumerable.Range(0, mesh.ElementCount).ToArray();
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }
        foreach (var cubes in cubesOfNode.Values) foreach (var c in cubes) parent[Find(c)] = Find(cubes[0]);
        Assert.That(Enumerable.Range(0, mesh.ElementCount).Select(Find).Distinct().Count(), Is.EqualTo(1));
    }

    [Test]
    public void The_boundary_elements_of_a_face_are_the_small_elements_on_that_side_with_the_solvers_face_index()
    {
        var fine = FineMesh.Build(Export(Bar(2)), 2, 2, 3);

        var xMinus = fine.BoundaryElements(0, "XMinus").ToList();
        var zPlus = fine.BoundaryElements(1, "ZPlus").ToList();

        Assert.That(xMinus.Count, Is.EqualTo(2 * 3));         // ny * nz
        Assert.That(xMinus.All(b => b.SolverFace == 4 && fine.Ex[b.Element] == 0 && fine.ParentOf[b.Element] == 0), Is.True);
        Assert.That(zPlus.Count, Is.EqualTo(2 * 2));          // nx * ny
        Assert.That(zPlus.All(b => b.SolverFace == 1 && fine.Ez[b.Element] == 2 && fine.ParentOf[b.Element] == 1), Is.True);
    }

    // ---- the solution on the divided mesh -----------------------------------------------------------

    private static SolverResultDto Solve(int nx, int ny, int nz, double poisson, int cubes = 3)
    {
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("m", "M", 2e11, poisson));
        facade.SetDefaultMaterial(Session, "m");
        facade.SetDivisions(Session, nx, ny, nz);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(cubes - 1, "XPlus") }, -1e6);
        var job = SolveAndWait(facade, Session, Export(Bar(cubes)));
        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        return facade.GetResult(Session)!;
    }

    private static double TipUx(SolverResultDto r, double x) =>
        Enumerable.Range(0, r.Ux.Count).Where(i => Math.Abs(r.Positions[3 * i] - x) < 1e-9).Average(i => r.Ux[i]);

    [Test]
    public void Cutting_the_cubes_does_not_change_a_uniaxial_bar_and_the_result_arrives_on_the_divided_mesh()
    {
        var coarse = Solve(1, 1, 1, 0.0);
        var fine = Solve(2, 2, 2, 0.0);
        var thin = Solve(3, 1, 1, 0.0);

        double expected = -1e6 * 3 / 2e11;
        Assert.That(TipUx(coarse, 3), Is.EqualTo(expected).Within(Math.Abs(expected) * 1e-6));
        Assert.That(TipUx(fine, 3), Is.EqualTo(expected).Within(Math.Abs(expected) * 1e-6));
        Assert.That(TipUx(thin, 3), Is.EqualTo(expected).Within(Math.Abs(expected) * 1e-6));
        Assert.That(fine.Divisions, Is.EqualTo(new[] { 2, 2, 2 }));
        Assert.That(fine.Ux.Count, Is.GreaterThan(coarse.Ux.Count));
        Assert.That(fine.HexIds, Is.EqualTo(new[] { 0, 1, 2 }));
        Assert.That(fine.GridNodes.Count, Is.EqualTo(3 * FineMesh.GridPoints(2, 2, 2).Length));
    }

    [Test]
    public void With_a_poisson_ratio_the_divided_solution_agrees_with_the_coarse_one_closely()
    {
        var coarse = Solve(1, 1, 1, 0.3);
        var fine = Solve(2, 2, 2, 0.3);

        Assert.That(TipUx(fine, 3), Is.EqualTo(TipUx(coarse, 3)).Within(Math.Abs(TipUx(coarse, 3)) * 0.02));
    }

    [Test]
    public void A_fixed_face_clamps_all_the_nodes_of_the_divided_face_and_nothing_else_moves_at_the_clamp()
    {
        var result = Solve(2, 2, 2, 0.3);

        var clamped = Enumerable.Range(0, result.Ux.Count).Where(i => Math.Abs(result.Positions[3 * i]) < 1e-12).ToList();

        Assert.That(clamped.Count, Is.EqualTo(21));
        Assert.That(clamped.All(i => Math.Abs(result.Ux[i]) + Math.Abs(result.Uy[i]) + Math.Abs(result.Uz[i]) < 1e-18), Is.True);
    }

    [Test]
    public void The_grid_nodes_of_each_cube_point_at_the_nodes_of_that_cube()
    {
        var result = Solve(2, 1, 1, 0.3, cubes: 2);
        var points = FineMesh.GridPoints(2, 1, 1);

        for (int c = 0; c < 2; c++)
            for (int i = 0; i < points.Length; i++)
            {
                int node = result.GridNodes[c * points.Length + i];
                Assert.That(result.Positions[3 * node], Is.EqualTo(c + points[i].X / 4.0).Within(1e-12));       // 2 cells of half a unit... (2n+1 = 5 points over one unit)
            }
    }

    [Test]
    public void A_curved_body_solves_when_divided()
    {
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("pipe").Build(new Dictionary<string, double> { ["around"] = 6, ["along"] = 2 }));
        var facade = NewFacade();
        facade.SetDivisions(Session, 2, 2, 2);
        facade.SetFixedFaces(Session, editor.Mesh.Hexes.Where(h => h.Cell.J == 0).Select(h => new SolverFaceDto(h.Id, "YMinus")).ToList(), true);
        facade.SetLoads(Session, editor.Mesh.Hexes.Where(h => h.Cell.J == 1).Select(h => new SolverFaceDto(h.Id, "YPlus")).ToList(), -1e6);

        var job = SolveAndWait(facade, Session, Export(editor));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        Assert.That(result.MaxVonMises, Is.GreaterThan(0).And.LessThan(30e6));
        Assert.That(result.Uy.Min(), Is.LessThan(0));
    }

    [Test]
    public void The_element_limit_counts_the_small_elements()
    {
        var facade = NewFacade();
        facade.SetDivisions(Session, 8, 8, 8);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        var mesh = Export(Bar(1));
        var many = mesh with { ElementCount = 50, ElementIds = Enumerable.Range(0, 50).ToArray(), Connectivity = Enumerable.Repeat(mesh.Connectivity, 50).SelectMany(c => c).ToArray() };

        var validation = facade.Validate(Session, many);

        Assert.That(validation.Issues.Select(i => i.Message), Has.Some.Contain("Забагато елементів"));
        Assert.That(validation.CanSolve, Is.False);
    }
}
