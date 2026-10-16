using Solvix.Contracts.Facades;
using Solvix.FemMesh.Local;
using Solvix.Fem;
using Solvix.Mesh;

namespace Solvix.FemMesh.Tests;

public class LocalRefinementTests
{
    private static LocalRefinement Refine(params RefinementStep[] steps) => new(steps);
    private static RefinementStep Cube(int cube, int n = 2, int depth = 0) => new(new[] { LocalRefinement.RootKey(cube) }, n, n, n, depth);

    // ---- measuring a mesh without trusting the code that made it ----

    // The volume of a hexahedron from its 8 corners, as the integral of the determinant of the Jacobian of the trilinear map over the element (2 x 2 x 2 Gauss points
    // are exact for it). A hexahedron with warped faces (the children of a template on a skew parent) has a volume that no split into tetrahedra gives exactly.
    private static double Volume(IFemMesh mesh, int e)
    {
        var xyz = Coordinates(mesh, e);
        double g = 1 / Math.Sqrt(3);
        double total = 0;
        foreach (double a in new[] { -g, g })
            foreach (double b in new[] { -g, g })
                foreach (double c in new[] { -g, g })
                {
                    var j = new double[3, 3];
                    for (int k = 0; k < 8; k++)
                    {
                        double sx = ElementLocal.Nodes[k, 0], sy = ElementLocal.Nodes[k, 1], sz = ElementLocal.Nodes[k, 2];
                        double[] d =
                        {
                            sx * (1 + sy * b) * (1 + sz * c) / 8, sy * (1 + sx * a) * (1 + sz * c) / 8, sz * (1 + sx * a) * (1 + sy * b) / 8
                        };
                        for (int axis = 0; axis < 3; axis++)
                            for (int col = 0; col < 3; col++) j[axis, col] += d[axis] * xyz[k, col];
                    }
                    total += j[0, 0] * (j[1, 1] * j[2, 2] - j[1, 2] * j[2, 1]) - j[0, 1] * (j[1, 0] * j[2, 2] - j[1, 2] * j[2, 0]) + j[0, 2] * (j[1, 0] * j[2, 1] - j[1, 1] * j[2, 0]);
                }
        return total;
    }

    // The area of a quadrilateral face from its 4 corners (the first 4 of the 8 nodes of the face: corners).
    private static double FaceArea(IFemMesh mesh, ElementFace face)
    {
        var corners = ElementLocal.FaceNodes[face.Face].Where(n => n < 8).ToArray();
        // order the 4 corners round the face: by their local coordinates
        var (axis, _) = ElementLocal.FaceAxis(face.Face);
        var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
        var ring = corners.OrderBy(n => Math.Atan2(ElementLocal.Nodes[n, tangents[1]], ElementLocal.Nodes[n, tangents[0]])).ToArray();
        double[] P(int k) => new[] { mesh.Positions[mesh.Connectivity[face.Element, k], 0], mesh.Positions[mesh.Connectivity[face.Element, k], 1], mesh.Positions[mesh.Connectivity[face.Element, k], 2] };
        double Tri(double[] a, double[] b, double[] c)
        {
            double[] u = { b[0] - a[0], b[1] - a[1], b[2] - a[2] }, v = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
            double x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
            return 0.5 * Math.Sqrt(x * x + y * y + z * z);
        }
        return Tri(P(ring[0]), P(ring[1]), P(ring[2])) + Tri(P(ring[0]), P(ring[2]), P(ring[3]));
    }

    private static double[,] Coordinates(IFemMesh mesh, int e)
    {
        var xyz = new double[20, 3];
        for (int k = 0; k < 20; k++)
            for (int c = 0; c < 3; c++) xyz[k, c] = mesh.Positions[mesh.Connectivity[e, k], c];
        return xyz;
    }

    private static void AssertSound(IFemMesh mesh, FemMeshDto coarse, double bodyVolume, double bodySurface)
    {
        double volume = 0;
        for (int e = 0; e < mesh.ElementCount; e++)
        {
            volume += Volume(mesh, e);
            var quality = ElementQuality.Of(Coordinates(mesh, e));
            Assert.That(quality.MinDeterminant, Is.GreaterThan(0), $"element {e} is folded or degenerate");
        }
        Assert.That(volume, Is.EqualTo(bodyVolume).Within(1e-9), "the elements fill the body exactly");
        double surface = mesh.SurfaceFaces().Sum(f => FaceArea(mesh, f));
        Assert.That(surface, Is.EqualTo(bodySurface).Within(1e-9), "the surface faces cover the surface of the body exactly, so no node hangs and nothing is left open");
        // every face is shared by exactly two elements or lies on the surface; a neighbour points back
        for (int e = 0; e < mesh.ElementCount; e++)
            for (int f = 0; f < 6; f++)
                if (mesh.Neighbour(new ElementFace(e, f)) is { } across) Assert.That(mesh.Neighbour(across), Is.EqualTo(new ElementFace(e, f)));
    }

    private static (HexMeshEditor Editor, FemMeshDto Coarse) Bar(int cubes)
    {
        var editor = Support.Bar(cubes);
        return (editor, Support.Export(editor));
    }

    // ---- the tests ----

    [Test]
    public void Nothing_to_refine_gives_the_cubes_themselves()
    {
        var (_, coarse) = Bar(3);

        var mesh = Refine().Build(coarse);

        Assert.That(mesh.ElementCount, Is.EqualTo(3));
        AssertSound(mesh, coarse, 3, 14);
    }

    [TestCase(0, 2)]
    [TestCase(1, 2)]
    [TestCase(1, 3)]
    [TestCase(2, 2)]
    public void A_refined_cube_in_a_bar_leaves_a_body_that_is_whole_and_conforming(int cube, int n)
    {
        var (_, coarse) = Bar(3);

        var mesh = Refine(Cube(cube, n)).Build(coarse);

        Assert.That(mesh.ElementCount, Is.GreaterThan(3 + n * n * n - 2));
        AssertSound(mesh, coarse, 3, 14);
        // the cube that was chosen is cut into n x n x n pieces
        Assert.That(mesh.ElementsOf(cube).Count, Is.GreaterThanOrEqualTo(n * n * n));
    }

    [TestCase(0)]
    [TestCase(1)]
    [TestCase(2)]
    public void The_depth_of_the_transition_zone_changes_how_far_the_refinement_spreads_but_never_the_soundness(int depth)
    {
        var (_, coarse) = Bar(4);

        var mesh = Refine(Cube(1, 2, depth)).Build(coarse);

        AssertSound(mesh, coarse, 4, 18);
    }

    [Test]
    public void Two_refinements_one_after_the_other_name_leaves_of_the_first()
    {
        var (_, coarse) = Bar(3);
        var first = Refine(Cube(1)).Build(coarse);
        // refine again the leaves of the middle cube that lie in its low-x corner: the leaf keys of the first result
        var leaves = Enumerable.Range(0, first.ElementCount).Where(e => first.RootOf(e) == 1 && first.CentreOf(e).X < 0 && first.CentreOf(e).Y < 0 && first.CentreOf(e).Z < 0)
            .Select(first.KeyOf).ToArray();
        Assert.That(leaves, Is.Not.Empty);

        var mesh = Refine(Cube(1), new RefinementStep(leaves, 2, 2, 2)).Build(coarse);

        Assert.That(mesh.ElementCount, Is.GreaterThan(first.ElementCount));
        AssertSound(mesh, coarse, 3, 14);
    }

    [Test]
    public void Replaying_the_same_history_gives_the_same_mesh_with_the_same_keys()
    {
        var (_, coarse) = Bar(3);
        var rule = Refine(Cube(1), Cube(0));

        var a = rule.Build(coarse);
        var b = rule.Build(coarse);

        Assert.That(b.ElementCount, Is.EqualTo(a.ElementCount));
        Assert.That(b.NodeCount, Is.EqualTo(a.NodeCount));
        for (int e = 0; e < a.ElementCount; e++)
        {
            Assert.That(b.KeyOf(e), Is.EqualTo(a.KeyOf(e)));
            for (int k = 0; k < 20; k++) Assert.That(b.Connectivity[e, k], Is.EqualTo(a.Connectivity[e, k]));
        }
        Assert.That(Enumerable.Range(0, a.ElementCount).Select(a.KeyOf).Distinct().Count(), Is.EqualTo(a.ElementCount), "no two leaves share a key");
    }

    [Test]
    public void The_history_follows_the_cube_by_its_id_not_by_its_place_in_the_list_when_other_cubes_are_removed()
    {
        var editor = Support.Bar(4);
        var rule = Refine(Cube(2, 2));
        int before = rule.Build(Support.Export(editor)).ElementsOf(2).Count;       // cube 2 is third in the list

        editor.RemoveHex(0);                                                          // now it is second
        var coarse = Support.Export(editor);
        var after = rule.Build(coarse);

        Assert.That(coarse.ElementIds, Is.EqualTo(new[] { 1, 2, 3 }));
        Assert.That(after.ElementsOf(1).Count, Is.EqualTo(before), "the cube with id 2 is still the refined one (it is the second in the list now)");
        Assert.That(after.ElementsOf(0).Count, Is.EqualTo(1).Or.GreaterThan(1), "its neighbour may get transition cells");
        Assert.That(Enumerable.Range(0, after.ElementCount).All(e => after.KeyOf(e).StartsWith(coarse.ElementIds[after.RootOf(e)] + "|")), Is.True, "every key begins with the id of its cube");
        AssertSound(after, coarse, 3, 14);
    }

    [Test]
    public void A_step_that_names_leaves_that_are_gone_is_skipped_and_the_rest_still_works()
    {
        var (_, coarse) = Bar(2);

        var mesh = Refine(Cube(7), new RefinementStep(new[] { "nonsense" }, 2, 2, 2), Cube(0)).Build(coarse);

        AssertSound(mesh, coarse, 2, 10);
        Assert.That(mesh.ElementCount, Is.GreaterThan(2));
    }

    [Test]
    public void Moving_a_corner_of_the_coarse_mesh_drags_the_children_with_it_and_keeps_them_sound()
    {
        var editor = Support.Bar(3);
        var rule = Refine(Cube(1));
        var before = rule.Build(Support.Export(editor));
        var node = editor.Mesh.Hex(1).NodeIds[6];
        editor.MoveNode(node, new Vec3(1.9, 1.15, 1.2), false);
        var coarse = Support.Export(editor);

        var after = rule.Build(coarse);

        Assert.That(after.ElementCount, Is.EqualTo(before.ElementCount), "the same refinement, only moved");
        double moved = 0;
        for (int n = 0; n < after.NodeCount; n++)
            moved = Math.Max(moved, Math.Abs(after.Positions[n, 0] - before.Positions[n, 0]) + Math.Abs(after.Positions[n, 1] - before.Positions[n, 1]) + Math.Abs(after.Positions[n, 2] - before.Positions[n, 2]));
        Assert.That(moved, Is.GreaterThan(0.1), "the children moved with their cube");
        for (int e = 0; e < after.ElementCount; e++) Assert.That(ElementQuality.Of(Coordinates(after, e)).MinDeterminant, Is.GreaterThan(0), $"element {e}");
        double volume = Enumerable.Range(0, after.ElementCount).Sum(e => Volume(after, e));
        Assert.That(volume, Is.GreaterThan(2.5).And.LessThan(3.5));
    }

    [Test]
    public void Cubes_that_are_not_linked_keep_nodes_of_their_own_and_linked_ones_share()
    {
        // two cubes side by side: linked, then not
        var editor = Support.Bar(2);
        var linked = Refine(Cube(0), Cube(1)).Build(Support.Export(editor));
        editor.UnlinkFace(editor.Mesh.Hex(0).Id, HexFace.XPlus);
        var apart = Refine(Cube(0), Cube(1)).Build(Support.Export(editor));

        Assert.That(linked.ElementCount, Is.EqualTo(apart.ElementCount));
        // 3x3 nodes... the face between them has 8 + ... nodes of a 2x2 cut: 25 - 4... count what is shared: a 2x2 face has 5x5 positions of which 21 are nodes (corners + midpoints)
        Assert.That(apart.NodeCount - linked.NodeCount, Is.EqualTo(21), "a 2 x 2 cut of the shared face has 3x3 corners and 12 midpoints");
        Assert.That(linked.SurfaceFaces().Count(), Is.EqualTo(apart.SurfaceFaces().Count() - 2 * 4), "the shared face is inside when linked, on the surface twice when not");
    }

    [Test]
    public void The_mesh_says_where_every_element_and_face_lies_in_its_cube_and_what_lies_on_a_side()
    {
        var (_, coarse) = Bar(2);

        var mesh = Refine(Cube(0)).Build(coarse);

        foreach (int cube in new[] { 0, 1 })
        {
            double volume = mesh.ElementsOf(cube).Sum(e => 1.0);
            Assert.That(volume, Is.GreaterThan(0));
            foreach (int e in mesh.ElementsOf(cube))
            {
                var c = mesh.CentreOf(e);
                for (int a = 0; a < 3; a++) Assert.That(c[a], Is.InRange(-1.0, 1.0));
            }
        }
        // the side of the refined cube that faces the other cube is a side, and its faces lie at the end of the cube
        var sideFaces = mesh.FacesOnSide(0, "XPlus").ToList();
        Assert.That(sideFaces, Is.Not.Empty);
        Assert.That(sideFaces.All(f => Math.Abs(mesh.FaceCentreOf(f).X - 1) < 1e-12), Is.True);
        // a face on a side of a cube has no hanging faces: the sides of the whole cube are tiled by its faces (area 4 in the cube's coordinates)
        foreach (var side in ElementLocal.FaceNames)
        {
            double area = mesh.FacesOnSide(0, side).Sum(f => FaceArea(mesh, f));
            Assert.That(area, Is.EqualTo(1.0).Within(1e-9), $"{side}: the side of the unit cube");
        }
    }
}

public class RegionsOfFacesTests
{
    private static RefinementStep Cube(int cube, int n = 2, int depth = 0) => new(new[] { LocalRefinement.RootKey(cube) }, n, n, n, depth);

    public static IEnumerable<TestCaseData> Meshes()
    {
        yield return new TestCaseData(new UniformRefinement(3, 2, 4), 3).SetName("uniform 3x2x4");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(1) }), 3).SetName("one cube");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(1, 3), Cube(2, 2, 2) }), 3).SetName("two cubes and a wide zone");
        yield return new TestCaseData(new LocalRefinement(new[] { Cube(0, 2, 1), Cube(2, 3, 1) }), 3).SetName("both ends");
    }

    // The corners of the face of an element on a side of a cube, flattened into the side's own plane (the two coordinates along the side).
    private static (double U, double V)[] Quad(IFemMesh mesh, ElementFace face, int[] tangents)
    {
        var corners = mesh.CornersOf(face.Element);
        var ring = ElementLocal.FaceNodes[face.Face].Where(n => n < 8).Select(n => corners[n]).Select(p => (U: p[tangents[0]], V: p[tangents[1]])).ToList();
        double cu = ring.Average(p => p.U), cv = ring.Average(p => p.V);
        return ring.OrderBy(p => Math.Atan2(p.V - cv, p.U - cu)).ToArray();
    }

    private static double Area((double U, double V)[] quad)
    {
        double twice = 0;
        for (int i = 0; i < quad.Length; i++) twice += quad[i].U * quad[(i + 1) % quad.Length].V - quad[(i + 1) % quad.Length].U * quad[i].V;
        return Math.Abs(twice) / 2;
    }

    // A point strictly inside a convex quadrilateral (its corners in order).
    private static bool Inside((double U, double V)[] quad, double u, double v)
    {
        int sign = 0;
        for (int i = 0; i < quad.Length; i++)
        {
            var (a, b) = (quad[i], quad[(i + 1) % quad.Length]);
            double cross = (b.U - a.U) * (v - a.V) - (b.V - a.V) * (u - a.U);
            if (Math.Abs(cross) < 1e-12) return false;
            int s = Math.Sign(cross);
            if (sign == 0) sign = s;
            else if (s != sign) return false;
        }
        return true;
    }

    // The faces of a mesh on a side of a cube are flat convex quadrilaterals (not always rectangles: next to a transition cell they are trapezoids) that tile the side
    // without a gap or an overlap: the side of the cube is [-1,1]^2, so their areas add up to 4, and no point of the side is inside two of them.
    [TestCaseSource(nameof(Meshes))]
    public void The_faces_on_a_side_are_convex_quadrilaterals_that_tile_it(IMeshRefinement rule, int cubes)
    {
        var mesh = rule.Build(Support.Export(Support.Bar(cubes)));
        int trapezoids = 0;

        for (int cube = 0; cube < cubes; cube++)
            foreach (var side in ElementLocal.FaceNames)
            {
                int axis = side[0] - 'X';
                var tangents = Enumerable.Range(0, 3).Where(d => d != axis).ToArray();
                var quads = mesh.FacesOnSide(cube, side).Select(f => Quad(mesh, f, tangents)).ToList();
                Assert.That(quads.Sum(Area), Is.EqualTo(4.0).Within(1e-9), $"cube {cube} {side}: the quadrilaterals fill the side");
                foreach (var quad in quads)
                {
                    double width = quad.Max(p => p.U) - quad.Min(p => p.U), height = quad.Max(p => p.V) - quad.Min(p => p.V);
                    if (Math.Abs(Area(quad) - width * height) > 1e-9) trapezoids++;
                }
                // sample the side: every sample is inside exactly one face, except the ones too near an edge to say
                for (int i = 0; i < 23; i++)
                    for (int j = 0; j < 23; j++)
                    {
                        double u = -1 + (i + 0.37) * 2 / 23, v = -1 + (j + 0.61) * 2 / 23;
                        int owners = quads.Count(q => Inside(q, u, v));
                        Assert.That(owners, Is.LessThanOrEqualTo(1), $"cube {cube} {side}: ({u:0.###}, {v:0.###}) is in two faces");
                    }
            }
        Assert.That(trapezoids, rule is UniformRefinement ? Is.EqualTo(0) : Is.GreaterThanOrEqualTo(0));
    }

    [TestCaseSource(nameof(Meshes))]
    public void The_corners_of_an_element_lie_in_its_cube_and_hold_its_centre(IMeshRefinement rule, int cubes)
    {
        var mesh = rule.Build(Support.Export(Support.Bar(cubes)));

        for (int e = 0; e < mesh.ElementCount; e++)
        {
            var corners = mesh.CornersOf(e);
            var centre = mesh.CentreOf(e);
            Assert.That(corners.Count, Is.EqualTo(8));
            for (int a = 0; a < 3; a++)
            {
                Assert.That(corners.All(c => c[a] >= -1 - 1e-9 && c[a] <= 1 + 1e-9), Is.True, $"element {e} lies in its cube");
                Assert.That(centre[a], Is.EqualTo(corners.Average(c => c[a])).Within(1e-9), "the centre is the middle of the corners");
            }
        }
    }
}
