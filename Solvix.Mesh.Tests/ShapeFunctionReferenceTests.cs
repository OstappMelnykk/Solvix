using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

// The shape functions are the contract between the CAD editor (isoparametric
// geometry) and the FEM solver, so they are checked against an independent
// transcription of the solver project's own N20 (AdaptiveMethods/Solution2,
// FemApi/FemRunner.cs): hard-coded corner signs and one explicit formula per
// midside node, with no lookup tables shared with Hex20Reference.
public class ShapeFunctionReferenceTests
{
    private static double[] ReferenceN20(double a, double b, double g)
    {
        int[] ca = { -1, +1, +1, -1, -1, +1, +1, -1 };
        int[] cb = { -1, -1, +1, +1, -1, -1, +1, +1 };
        int[] cg = { -1, -1, -1, -1, +1, +1, +1, +1 };
        var n = new double[20];
        for (int i = 0; i < 8; i++)
        {
            double A = ca[i], B = cb[i], G = cg[i];
            n[i] = 0.125 * (1 + A * a) * (1 + B * b) * (1 + G * g) * (A * a + B * b + G * g - 2);
        }
        n[8] = 0.25 * (1 - a * a) * (1 - b) * (1 - g);
        n[9] = 0.25 * (1 + a) * (1 - b * b) * (1 - g);
        n[10] = 0.25 * (1 - a * a) * (1 + b) * (1 - g);
        n[11] = 0.25 * (1 - a) * (1 - b * b) * (1 - g);
        n[12] = 0.25 * (1 - a * a) * (1 - b) * (1 + g);
        n[13] = 0.25 * (1 + a) * (1 - b * b) * (1 + g);
        n[14] = 0.25 * (1 - a * a) * (1 + b) * (1 + g);
        n[15] = 0.25 * (1 - a) * (1 - b * b) * (1 + g);
        n[16] = 0.25 * (1 - a) * (1 - b) * (1 - g * g);
        n[17] = 0.25 * (1 + a) * (1 - b) * (1 - g * g);
        n[18] = 0.25 * (1 + a) * (1 + b) * (1 - g * g);
        n[19] = 0.25 * (1 - a) * (1 + b) * (1 - g * g);
        return n;
    }

    [Test]
    public void Shape_functions_match_the_solvers_N20_node_for_node_at_random_points()
    {
        var rng = new Random(2026);
        var mine = new double[20];
        for (int p = 0; p < 500; p++)
        {
            double a = rng.NextDouble() * 2.6 - 1.3, b = rng.NextDouble() * 2.6 - 1.3, g = rng.NextDouble() * 2.6 - 1.3;   // also outside the cube
            Hex20Reference.ShapeFunctions(a, b, g, mine);
            var reference = ReferenceN20(a, b, g);
            for (int i = 0; i < 20; i++)
                Assert.That(mine[i], Is.EqualTo(reference[i]).Within(1e-12), $"node {i} at ({a}, {b}, {g})");
        }
    }

    [Test]
    public void The_local_coordinates_of_every_node_are_where_the_solvers_functions_are_one()
    {
        for (int i = 0; i < 20; i++)
        {
            var n = ReferenceN20(Hex20Reference.LocalCoords[i, 0], Hex20Reference.LocalCoords[i, 1], Hex20Reference.LocalCoords[i, 2]);
            for (int j = 0; j < 20; j++)
                Assert.That(n[j], Is.EqualTo(i == j ? 1.0 : 0.0).Within(1e-12), $"N{j} at the local coordinates of node {i}");
        }
    }

    [Test]
    public void Derivatives_match_central_differences_of_the_solvers_functions()
    {
        const double h = 1e-6;
        var d = new double[20, 3];
        foreach (var (a, b, g) in new[] { (0.3, -0.2, 0.7), (-0.9, 0.5, 0.1), (1.1, 1.2, -0.4) })
        {
            Hex20Reference.ShapeDerivatives(a, b, g, d);
            double[][] plus = { ReferenceN20(a + h, b, g), ReferenceN20(a, b + h, g), ReferenceN20(a, b, g + h) };
            double[][] minus = { ReferenceN20(a - h, b, g), ReferenceN20(a, b - h, g), ReferenceN20(a, b, g - h) };
            for (int i = 0; i < 20; i++)
                for (int axis = 0; axis < 3; axis++)
                    Assert.That(d[i, axis], Is.EqualTo((plus[axis][i] - minus[axis][i]) / (2 * h)).Within(1e-6), $"d phi{i}/d{axis}");
        }
    }

    [Test]
    public void The_map_uses_local_slot_i_with_the_hexs_global_node_at_slot_i()
    {
        // Each slot gets a distinct position; the map at a node's own local coordinates
        // must return exactly the position of that slot's GLOBAL node.
        var mesh = new HexMesh();
        var hex = mesh.AddFirst();
        for (int slot = 0; slot < 20; slot++)
            mesh.SetNodePosition(hex.NodeIds[slot], new Vec3(10 + slot, 20 - slot * 0.5, slot * slot));

        for (int slot = 0; slot < 20; slot++)
        {
            var xi = new Vec3(Hex20Reference.LocalCoords[slot, 0], Hex20Reference.LocalCoords[slot, 1], Hex20Reference.LocalCoords[slot, 2]);
            var expected = mesh.Node(hex.NodeIds[slot]).Position;
            Assert.That((hex.Map(xi) - expected).Length, Is.LessThan(1e-9), $"slot {slot}");
        }
    }

    [Test]
    public void Neighbouring_hexes_agree_on_every_shared_node_through_their_own_local_numbers()
    {
        var mesh = new HexMesh();
        var a = mesh.AddFirst();
        var b = mesh.AddOnFace(a.Id, HexFace.XPlus);
        mesh.DragNode(b.NodeIds[0], new Vec3(1, -0.2, -0.1));   // a shared corner

        foreach (int slotInA in HexFace.XPlus.Slots())
        {
            int slotInB = HexFace.XPlus.PartnerSlot(slotInA);
            Assert.That(a.NodeIds[slotInA], Is.EqualTo(b.NodeIds[slotInB]), $"local {slotInA} in A is local {slotInB} in B");
            var xiA = new Vec3(Hex20Reference.LocalCoords[slotInA, 0], Hex20Reference.LocalCoords[slotInA, 1], Hex20Reference.LocalCoords[slotInA, 2]);
            var xiB = new Vec3(Hex20Reference.LocalCoords[slotInB, 0], Hex20Reference.LocalCoords[slotInB, 1], Hex20Reference.LocalCoords[slotInB, 2]);
            Assert.That((a.Map(xiA) - b.Map(xiB)).Length, Is.LessThan(1e-12));
        }
    }
}
