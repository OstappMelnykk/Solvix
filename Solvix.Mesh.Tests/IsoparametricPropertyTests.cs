using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

// The defining property of the 20-node isoparametric element: the 20 base nodes are
// independent control points. x(xi) = sum_i phi_i(xi) * x_i, and phi_i(node j) is
// the Kronecker delta, so
//   - moving ONE base node k by D changes none of the other 19 base nodes, and
//     the map still passes through every one of them;
//   - every other point xi of the cube (a point that is not one of the 20 base nodes,
//     like the extra nodes a refinement will create) moves by exactly phi_k(xi) * D.
public class IsoparametricPropertyTests
{
    private static Vec3 LocalOf(int slot) => new(Hex20Reference.LocalCoords[slot, 0], Hex20Reference.LocalCoords[slot, 1], Hex20Reference.LocalCoords[slot, 2]);

    // A unit cube whose 20 nodes have been scattered, so the property is checked on a
    // general curvilinear hex and not just on the undeformed one.
    private static (HexMeshEditor Editor, Hex20 Hex) ScatteredCube(int seed, double amplitude)
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        var hex = editor.Mesh.Hex(0);
        var rng = new Random(seed);
        foreach (int id in hex.NodeIds)
        {
            var p = editor.Mesh.Node(id).Position;
            editor.Mesh.SetNodePosition(id, p + new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * (2 * amplitude));
        }
        return (editor, hex);
    }

    private static Vec3 RandomPoint(Random rng) => new(rng.NextDouble() * 2 - 1, rng.NextDouble() * 2 - 1, rng.NextDouble() * 2 - 1);

    [Test]
    public void Moving_one_base_node_leaves_the_other_nineteen_exactly_where_they_were()
    {
        var rng = new Random(1);
        for (int trial = 0; trial < 60; trial++)
        {
            var (editor, hex) = ScatteredCube(trial, 0.15);
            int k = rng.Next(20);
            var before = hex.NodeIds.Select(id => editor.Mesh.Node(id).Position).ToArray();
            var delta = new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * 0.6;

            Assert.That(editor.MoveNode(hex.NodeIds[k], before[k] + delta, carryEdgeMidpoints: false).Ok, Is.True);

            for (int j = 0; j < 20; j++)
            {
                var expected = j == k ? before[k] + delta : before[j];
                Assert.That(editor.Mesh.Node(hex.NodeIds[j]).Position, Is.EqualTo(expected), $"node {j} after moving node {k}");
                // and the map still passes through every base node
                Assert.That((hex.Map(LocalOf(j)) - expected).Length, Is.LessThan(1e-9), $"map at the local coordinates of node {j}");
            }
        }
    }

    [Test]
    public void Every_point_that_is_not_a_base_node_moves_by_exactly_phi_k_times_the_displacement()
    {
        var rng = new Random(2);
        var phi = new double[20];
        for (int trial = 0; trial < 40; trial++)
        {
            var (editor, hex) = ScatteredCube(100 + trial, 0.1);
            int k = rng.Next(20);
            var points = Enumerable.Range(0, 25).Select(_ => RandomPoint(rng)).ToArray();
            var before = points.Select(hex.Map).ToArray();
            var delta = new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5);

            editor.MoveNode(hex.NodeIds[k], editor.Mesh.Node(hex.NodeIds[k]).Position + delta, carryEdgeMidpoints: false);

            for (int p = 0; p < points.Length; p++)
            {
                Hex20Reference.ShapeFunctions(points[p].X, points[p].Y, points[p].Z, phi);
                var moved = hex.Map(points[p]) - before[p];
                Assert.That((moved - delta * phi[k]).Length, Is.LessThan(1e-12), $"point {points[p]} when node {k} moves");
            }
        }
    }

    [Test]
    public void The_base_nodes_do_not_move_through_the_map_even_at_a_dense_scan_of_other_base_node_moves()
    {
        // every node k, several displacements: the other 19 nodes' images never change
        var (editor, hex) = ScatteredCube(7, 0.2);
        var rng = new Random(3);
        for (int k = 0; k < 20; k++)
        {
            for (int repeat = 0; repeat < 5; repeat++)
            {
                var snapshot = Enumerable.Range(0, 20).Select(j => hex.Map(LocalOf(j))).ToArray();
                var step = new Vec3(rng.NextDouble() - 0.5, rng.NextDouble() - 0.5, rng.NextDouble() - 0.5) * 0.3;
                editor.MoveNode(hex.NodeIds[k], editor.Mesh.Node(hex.NodeIds[k]).Position + step, carryEdgeMidpoints: false);

                for (int j = 0; j < 20; j++)
                {
                    var image = hex.Map(LocalOf(j));
                    if (j == k) Assert.That((image - (snapshot[j] + step)).Length, Is.LessThan(1e-9));
                    else Assert.That((image - snapshot[j]).Length, Is.LessThan(1e-9), $"node {j} moved when node {k} was dragged");
                }
            }
        }
    }

    [Test]
    public void The_displacement_of_a_point_is_largest_near_the_moved_node_and_zero_at_the_other_base_nodes()
    {
        var (editor, hex) = ScatteredCube(11, 0.05);
        const int k = 6;                                  // corner (+1,+1,+1)
        var delta = new Vec3(0.4, -0.3, 0.2);
        Vec3 Shift(Vec3 xi, Func<Vec3, Vec3> map) => map(xi);
        var near = new Vec3(0.9, 0.9, 0.9);
        var middle = new Vec3(0, 0, 0);
        var far = new Vec3(-0.9, -0.9, -0.9);
        var nearBefore = hex.Map(near); var middleBefore = hex.Map(middle); var farBefore = hex.Map(far);

        editor.MoveNode(hex.NodeIds[k], editor.Mesh.Node(hex.NodeIds[k]).Position + delta, carryEdgeMidpoints: false);

        double Moved(Vec3 xi, Vec3 before) => (Shift(xi, hex.Map) - before).Length;
        Assert.That(Moved(near, nearBefore), Is.GreaterThan(Moved(middle, middleBefore)));
        Assert.That(Moved(middle, middleBefore), Is.GreaterThan(Moved(far, farBefore)));
    }

    [Test]
    public void A_node_shared_by_two_cubes_moves_both_but_still_only_by_its_own_shape_function()
    {
        var editor = new HexMeshEditor();
        editor.AddFirstHex();
        editor.AddHexOnFace(0, HexFace.XPlus);
        var a = editor.Mesh.Hex(0);
        var b = editor.Mesh.Hex(1);
        int sharedNode = a.NodeIds[1];                    // local 1 in A, local 0 in B
        var pointInA = new Vec3(0.3, -0.2, 0.5);
        var pointInB = new Vec3(-0.4, 0.6, -0.1);
        var beforeA = a.Map(pointInA); var beforeB = b.Map(pointInB);
        var delta = new Vec3(0.2, 0.3, -0.1);
        var phi = new double[20];

        editor.MoveNode(sharedNode, editor.Mesh.Node(sharedNode).Position + delta, carryEdgeMidpoints: false);

        Hex20Reference.ShapeFunctions(pointInA.X, pointInA.Y, pointInA.Z, phi);
        Assert.That((a.Map(pointInA) - beforeA - delta * phi[1]).Length, Is.LessThan(1e-12));
        Hex20Reference.ShapeFunctions(pointInB.X, pointInB.Y, pointInB.Z, phi);
        Assert.That((b.Map(pointInB) - beforeB - delta * phi[0]).Length, Is.LessThan(1e-12));
        // no other base node of either cube moved
        for (int slot = 0; slot < 20; slot++)
        {
            if (slot == 1) continue;
            Assert.That(editor.Mesh.Node(a.NodeIds[slot]).Position, Is.Not.EqualTo(editor.Mesh.Node(sharedNode).Position));
        }
        Assert.That(a.NodeIds[1], Is.EqualTo(b.NodeIds[0]));
    }

    [Test]
    public void Moving_a_node_without_carry_never_touches_edge_midpoints_through_the_editor_or_the_raw_setter()
    {
        var (editor, hex) = ScatteredCube(5, 0.1);
        var mids = Enumerable.Range(8, 12).Select(i => editor.Mesh.Node(hex.NodeIds[i]).Position).ToArray();

        for (int corner = 0; corner < 8; corner++)
            editor.MoveNode(hex.NodeIds[corner], editor.Mesh.Node(hex.NodeIds[corner]).Position + new Vec3(0.1, -0.2, 0.3), carryEdgeMidpoints: false);

        for (int i = 0; i < 12; i++)
            Assert.That(editor.Mesh.Node(hex.NodeIds[8 + i]).Position, Is.EqualTo(mids[i]));
    }
}
