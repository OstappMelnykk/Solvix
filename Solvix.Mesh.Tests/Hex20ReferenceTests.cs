using Solvix.Mesh;

namespace Solvix.Mesh.Tests;

public class Hex20ReferenceTests
{
    [Test]
    public void ShapeFunctions_are_one_at_their_own_node_and_zero_at_the_others()
    {
        var phi = new double[20];
        for (int i = 0; i < 20; i++)
        {
            Hex20Reference.ShapeFunctions(Hex20Reference.LocalCoords[i, 0], Hex20Reference.LocalCoords[i, 1], Hex20Reference.LocalCoords[i, 2], phi);
            for (int j = 0; j < 20; j++)
                Assert.That(phi[j], Is.EqualTo(i == j ? 1.0 : 0.0).Within(1e-12), $"phi[{j}] at node {i}");
        }
    }

    [Test]
    public void ShapeFunctions_form_a_partition_of_unity()
    {
        var phi = new double[20];
        Hex20Reference.ShapeFunctions(0.3, -0.7, 0.45, phi);
        Assert.That(phi.Sum(), Is.EqualTo(1.0).Within(1e-12));
    }

    [Test]
    public void ShapeDerivatives_match_finite_differences()
    {
        const double h = 1e-6;
        var d = new double[20, 3];
        Hex20Reference.ShapeDerivatives(0.21, -0.4, 0.6, d);
        var plus = new double[20];
        var minus = new double[20];
        double[] p = { 0.21, -0.4, 0.6 };
        for (int axis = 0; axis < 3; axis++)
        {
            var a = (double[])p.Clone(); a[axis] += h;
            var b = (double[])p.Clone(); b[axis] -= h;
            Hex20Reference.ShapeFunctions(a[0], a[1], a[2], plus);
            Hex20Reference.ShapeFunctions(b[0], b[1], b[2], minus);
            for (int i = 0; i < 20; i++)
                Assert.That(d[i, axis], Is.EqualTo((plus[i] - minus[i]) / (2 * h)).Within(1e-6), $"node {i} axis {axis}");
        }
    }

    [Test]
    public void Edge_midpoint_slots_lie_halfway_between_their_corners()
    {
        for (int k = 0; k < 12; k++)
        {
            var (a, b) = Hex20Reference.EdgeCorners[k];
            for (int axis = 0; axis < 3; axis++)
                Assert.That(2 * Hex20Reference.LocalCoords[8 + k, axis],
                    Is.EqualTo(Hex20Reference.LocalCoords[a, axis] + Hex20Reference.LocalCoords[b, axis]));
        }
    }

    [Test]
    public void Every_face_has_four_corners_and_four_midpoints_and_pairs_with_its_opposite()
    {
        foreach (var face in HexFaces.All)
        {
            var slots = face.Slots();
            Assert.That(slots.Count, Is.EqualTo(8));
            Assert.That(slots.Count(Hex20Reference.IsCorner), Is.EqualTo(4));
            var partners = slots.Select(s => face.PartnerSlot(s)).ToList();
            Assert.That(partners, Has.All.GreaterThanOrEqualTo(0));
            Assert.That(partners.Distinct().Count(), Is.EqualTo(8));
            Assert.That(partners.Select(p => face.Opposite().Slots().Contains(p)), Has.All.True);
        }
    }
}
