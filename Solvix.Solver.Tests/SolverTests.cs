using FemSolver;
using Solvix.Contracts.Facades;
using Solvix.Mesh;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

public class SolverTests
{
    private const int Session = 1;

    // The index of the first node of a result whose position satisfies the test.
    private static int NodeWhere(SolverResultDto result, Func<double, double, double, bool> test) =>
        Enumerable.Range(0, result.Ux.Count).First(i => test(result.Positions[3 * i], result.Positions[3 * i + 1], result.Positions[3 * i + 2]));

    // ---- conventions ------------------------------------------------------------------------------

    [Test]
    public void The_editors_faces_are_the_solvers_faces()
    {
        // for every editor face, the solver's face of the same name lists exactly the 8 slots that lie on it
        foreach (var face in HexFaces.All)
        {
            Assert.That(SolverFaces.TryParse(face.ToString(), out int solverFace), Is.True);
            var solverSlots = ElementLoad.FaceNodeMaps[solverFace].OrderBy(i => i).ToArray();
            Assert.That(solverSlots, Is.EqualTo(face.Slots().OrderBy(i => i).ToArray()), face.ToString());
        }
    }

    [Test]
    public void The_solvers_outward_normal_matches_the_editors_faces()
    {
        // a unit cube: pressure -1 (outward pull of 1 Pa) on every face of ZPlus must push the cube's top nodes up
        var facade = NewFacade();
        var editor = Bar(1);
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "ZMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(0, "ZPlus") }, 1000);   // Pn > 0 = along the outward normal = pulling out

        var job = SolveAndWait(facade, Session, Export(editor));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        int top = NodeWhere(result, (_, _, z) => z == 1);
        Assert.That(result.Uz[top], Is.GreaterThan(0));
    }

    // ---- the physics ------------------------------------------------------------------------------

    [Test]
    public void One_material_gives_the_same_answer_as_the_solvers_own_core()
    {
        var editor = Bar(3);
        var mesh = Export(editor);
        var facade = NewFacade();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(2, "XPlus") }, -5e6);
        var job = SolveAndWait(facade, Session, mesh);
        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var ours = facade.GetResult(Session)!;

        // the same problem through FemSolverCore
        var fem = editor.Mesh.ToFemMesh();
        var femMesh = new FemMesh { NodeCount = fem.NodeCount, ElementCount = fem.ElementCount, Positions = fem.Positions, Connectivity = fem.Connectivity };
        var load = LoadAssembler.AssemblePressure(femMesh, -5e6, ShapeFunctions.PrecomputeSurfaceDerivatives(), new HashSet<long> { 2L * 6 + 5 });
        var fixedDofs = BoundaryConditions.GetFixedDOFsFromFaceSet(femMesh, new HashSet<long> { 0L * 6 + 4 }).ToArray();
        var reference = FemSolverCore.Solve(new FemProblem { Mesh = femMesh, Material = new FemMaterial { E = 2.1e11, Nu = 0.3 }, FixedDofs = fixedDofs, LoadVector = load });

        // our nodes are numbered in their own order: match them by position
        string Key(double x, double y, double z) => $"{Math.Round(x, 9)}|{Math.Round(y, 9)}|{Math.Round(z, 9)}";
        var ourNode = Enumerable.Range(0, ours.Ux.Count).ToDictionary(i => Key(ours.Positions[3 * i], ours.Positions[3 * i + 1], ours.Positions[3 * i + 2]));
        Assert.That(ours.Ux.Count, Is.EqualTo(fem.NodeCount));
        int Mine(int n) => ourNode[Key(fem.Positions[n, 0], fem.Positions[n, 1], fem.Positions[n, 2])];

        double scale = reference.Displacements.Max(Math.Abs);
        for (int n = 0; n < fem.NodeCount; n++)
        {
            int m = Mine(n);
            Assert.That(ours.Ux[m], Is.EqualTo(reference.Displacements[n]).Within(1e-6 * scale), $"ux {n}");
            Assert.That(ours.Uy[m], Is.EqualTo(reference.Displacements[fem.NodeCount + n]).Within(1e-6 * scale), $"uy {n}");
            Assert.That(ours.Uz[m], Is.EqualTo(reference.Displacements[2 * fem.NodeCount + n]).Within(1e-6 * scale), $"uz {n}");
        }
        // the stress is recovered at the Gauss point nearest each node, so it differs from the node values of the
        // solver's own recovery near the clamp, but stays close overall
        double vmScale = reference.VonMises.Max();
        double meanDifference = Enumerable.Range(0, fem.NodeCount).Average(n => Math.Abs(ours.VonMises[Mine(n)] - reference.VonMises[n])) / vmScale;
        Assert.That(meanDifference, Is.LessThan(0.05));
        Assert.That(ours.MaxVonMises, Is.EqualTo(vmScale).Within(0.2 * vmScale));
    }

    [Test]
    public void Layers_of_different_materials_add_up_like_springs_in_series()
    {
        // 3 steel cubes then 2 rubber cubes; nu = 0, so a clamped bar under uniform pressure is exactly uniaxial
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("steel0", "Сталь", 2.0e11, 0.0));
        facade.UpsertMaterial(Session, new SolverMaterialDto("rubber0", "Гума", 1.0e7, 0.0));
        facade.SetDefaultMaterial(Session, "steel0");
        facade.SetHexMaterial(Session, new[] { 3, 4 }, "rubber0");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        double pressure = 1e5;
        facade.SetLoads(Session, new[] { new SolverFaceDto(4, "XPlus") }, -pressure);   // compression
        var editor = Bar(5);

        var job = SolveAndWait(facade, Session, Export(editor));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        double expectedTip = -pressure * (3 / 2.0e11 + 2 / 1.0e7);
        int tip = NodeWhere(result, (x, _, _) => x == 5);
        Assert.That(result.Ux[tip], Is.EqualTo(expectedTip).Within(Math.Abs(expectedTip) * 1e-5));
        // the steel part barely moves compared with the rubber part
        int junction = NodeWhere(result, (x, _, _) => x == 3);
        Assert.That(result.Ux[junction], Is.EqualTo(-pressure * 3 / 2.0e11).Within(1e-9));
        // the stress is the pressure everywhere (away from the interface, where nodes blend their two sides)
        int inSteel = NodeWhere(result, (x, _, _) => x == 1);
        int inRubber = NodeWhere(result, (x, _, _) => x == 4.5);
        Assert.That(result.VonMises[inSteel], Is.EqualTo(pressure).Within(pressure * 1e-4));
        Assert.That(result.VonMises[inRubber], Is.EqualTo(pressure).Within(pressure * 1e-4));
    }

    [Test]
    public void A_negative_pressure_presses_into_the_body_and_a_positive_one_pulls()
    {
        var facade = NewFacade();
        facade.UpsertMaterial(Session, new SolverMaterialDto("m0", "M", 1e9, 0.0));
        facade.SetDefaultMaterial(Session, "m0");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);
        var editor = Bar(2);
        int tip() => NodeWhere(facade.GetResult(Session)!, (x, _, _) => x == 2);

        facade.SetLoads(Session, new[] { new SolverFaceDto(1, "XPlus") }, -1e4);
        SolveAndWait(facade, Session, Export(editor));
        double pushed = facade.GetResult(Session)!.Ux[tip()];
        facade.SetLoads(Session, new[] { new SolverFaceDto(1, "XPlus") }, 1e4);
        SolveAndWait(facade, Session, Export(editor));
        double pulled = facade.GetResult(Session)!.Ux[tip()];

        Assert.That(pushed, Is.LessThan(0));
        Assert.That(pulled, Is.GreaterThan(0));
        Assert.That(pulled, Is.EqualTo(-pushed).Within(1e-12));
    }

    [Test]
    public void No_load_gives_a_zero_solution()
    {
        var facade = NewFacade();
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, true);

        var job = SolveAndWait(facade, Session, Export(Bar(2)));

        Assert.That(job.State, Is.EqualTo("done"));
        Assert.That(facade.GetResult(Session)!.MaxDisplacement, Is.EqualTo(0));
    }

    [Test]
    public void A_curved_body_solves_too()
    {
        var editor = new HexMeshEditor();
        editor.AddBody(HexTemplates.Kind("pipe").Build(new Dictionary<string, double> { ["around"] = 8, ["along"] = 2 }));
        var facade = NewFacade();
        var bottom = editor.Mesh.Hexes.Where(h => h.Cell.J == 0).Select(h => new SolverFaceDto(h.Id, "YMinus")).ToList();
        var top = editor.Mesh.Hexes.Where(h => h.Cell.J == 1).Select(h => new SolverFaceDto(h.Id, "YPlus")).ToList();
        facade.SetFixedFaces(Session, bottom, true);
        facade.SetLoads(Session, top, -1e6);

        var job = SolveAndWait(facade, Session, Export(editor));

        Assert.That(job.State, Is.EqualTo("done"), job.Error);
        var result = facade.GetResult(Session)!;
        Assert.That(result.MaxDisplacement, Is.GreaterThan(0));
        Assert.That(result.MaxVonMises, Is.GreaterThan(0));
        // compressed along the axis: the free end moves down (towards -y)
        Assert.That(result.Uy.Min(), Is.LessThan(0));
        // the barely valid cubes along the pipe's lattice corners must not produce absurd stress: it stays within a
        // small multiple of the pressure that causes it
        Assert.That(result.MaxVonMises, Is.LessThan(30 * 1e6));
    }

    // ---- set-up -----------------------------------------------------------------------------------

    [Test]
    public void The_setup_keeps_materials_supports_and_loads_and_clears_them()
    {
        var facade = NewFacade();
        Assert.That(facade.GetSetup(Session).Materials.Select(m => m.Name), Does.Contain("steel").And.Contain("rubber").And.Contain("enamel"));

        facade.SetHexMaterial(Session, new[] { 1, 2 }, "rubber");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus"), new SolverFaceDto(0, "Nope") }, true);
        var setup = facade.SetLoads(Session, new[] { new SolverFaceDto(2, "XPlus") }, 1e5);

        Assert.That(setup.HexMaterials, Is.EquivalentTo(new Dictionary<int, string> { [1] = "rubber", [2] = "rubber" }));
        Assert.That(setup.Fixed, Is.EqualTo(new[] { new SolverFaceDto(0, "XMinus") }));
        Assert.That(setup.Loads, Has.Count.EqualTo(1));

        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus") }, false);
        facade.SetLoads(Session, new[] { new SolverFaceDto(2, "XPlus") }, null);
        facade.SetHexMaterial(Session, new[] { 1 }, null);
        setup = facade.GetSetup(Session);
        Assert.That(setup.Fixed, Is.Empty);
        Assert.That(setup.Loads, Is.Empty);
        Assert.That(setup.HexMaterials.Keys, Is.EqualTo(new[] { 2 }));

        Assert.That(facade.ClearSetup(Session).HexMaterials, Is.Empty);
    }

    [Test]
    public void Unknown_materials_and_invalid_ones_are_refused_without_changing_anything()
    {
        var facade = NewFacade();
        int version = facade.GetSetup(Session).Version;

        facade.SetHexMaterial(Session, new[] { 0 }, "unobtainium");
        facade.SetDefaultMaterial(Session, "unobtainium");
        facade.UpsertMaterial(Session, new SolverMaterialDto("bad", "Bad", -1, 0.3));
        facade.UpsertMaterial(Session, new SolverMaterialDto("bad2", "Bad2", 1e9, 0.5));
        facade.UpsertMaterial(Session, new SolverMaterialDto("bad3", "Bad3", double.NaN, 0.3));

        var setup = facade.GetSetup(Session);
        Assert.That(setup.Version, Is.EqualTo(version));
        Assert.That(setup.Materials.Select(m => m.Name), Does.Not.Contain("bad"));
        Assert.That(setup.DefaultMaterial, Is.EqualTo("steel"));
    }

    [Test]
    public void A_material_can_be_replaced_and_the_default_changed()
    {
        var facade = NewFacade();

        facade.UpsertMaterial(Session, new SolverMaterialDto("steel", "Сталь", 1.9e11, 0.29));
        var setup = facade.SetDefaultMaterial(Session, "concrete");

        Assert.That(setup.Materials.Single(m => m.Name == "steel").E, Is.EqualTo(1.9e11));
        Assert.That(setup.DefaultMaterial, Is.EqualTo("concrete"));
    }

    [Test]
    public void Pruning_drops_what_belongs_to_deleted_cubes()
    {
        var facade = NewFacade();
        facade.SetHexMaterial(Session, new[] { 0, 5 }, "rubber");
        facade.SetFixedFaces(Session, new[] { new SolverFaceDto(0, "XMinus"), new SolverFaceDto(5, "XMinus") }, true);
        facade.SetLoads(Session, new[] { new SolverFaceDto(5, "XPlus") }, 1e5);

        var setup = facade.Prune(Session, new[] { 0, 1, 2 });

        Assert.That(setup.HexMaterials.Keys, Is.EqualTo(new[] { 0 }));
        Assert.That(setup.Fixed, Is.EqualTo(new[] { new SolverFaceDto(0, "XMinus") }));
        Assert.That(setup.Loads, Is.Empty);
    }

    [Test]
    public void Sessions_do_not_share_their_setup()
    {
        var facade = NewFacade();
        facade.SetFixedFaces(1, new[] { new SolverFaceDto(0, "XMinus") }, true);

        Assert.That(facade.GetSetup(2).Fixed, Is.Empty);
        facade.DropSession(1);
        Assert.That(facade.GetSetup(1).Fixed, Is.Empty);
    }
}
