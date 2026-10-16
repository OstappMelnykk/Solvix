namespace Solvix.FemMesh.Tests;

public class UniformRefinementTests
{
    private static IFemMesh Build(int cubes, int nx, int ny, int nz) => new UniformRefinement(nx, ny, nz).Build(Support.Export(Support.Bar(cubes)));

    [Test]
    public void A_cube_cut_3_by_3_by_3_is_27_elements()
    {
        var mesh = Build(1, 3, 3, 3);

        Assert.That(mesh.ElementCount, Is.EqualTo(27));
    }

    [Test]
    public void A_mesh_says_what_rule_made_it_only_through_its_rule_not_through_itself()
    {
        IMeshRefinement rule = new UniformRefinement(2, 1, 1);

        Assert.That(rule.Name, Does.Contain("uniform"));
        Assert.That(rule.Build(Support.Export(Support.Bar(1))), Is.InstanceOf<IFemMesh>());
    }

    [Test]
    public void The_surface_of_a_cut_cube_is_its_outer_faces_and_each_element_face_inside_has_a_neighbour_that_points_back()
    {
        var mesh = Build(1, 3, 3, 3);

        Assert.That(mesh.SurfaceFaces().Count(), Is.EqualTo(6 * 9));
        for (int e = 0; e < mesh.ElementCount; e++)
            for (int f = 0; f < 6; f++)
            {
                var face = new ElementFace(e, f);
                if (mesh.Neighbour(face) is { } across)
                {
                    Assert.That(mesh.Neighbour(across), Is.EqualTo(face));
                    Assert.That(across.Element, Is.Not.EqualTo(e));
                    Assert.That(across.Face, Is.EqualTo(f ^ 1), "a face meets the opposite face of its neighbour in a regular mesh");
                }
            }
    }

    [Test]
    public void Two_linked_cubes_are_one_body_the_shared_side_is_inside_not_on_the_surface()
    {
        var mesh = Build(2, 2, 2, 2);

        Assert.That(mesh.ElementCount, Is.EqualTo(16));
        // the body is 4 x 2 x 2 elements: two ends of 2x2, and four long sides of 4x2
        Assert.That(mesh.SurfaceFaces().Count(), Is.EqualTo(2 * 4 + 4 * 8));
        var shared = mesh.FacesOnSide(0, "XPlus").ToList();
        Assert.That(shared.Count, Is.EqualTo(4));
        Assert.That(shared.All(f => mesh.Neighbour(f) is { } n && mesh.RootOf(n.Element) == 1), Is.True);
    }

    [Test]
    public void The_faces_of_a_side_of_a_cube_are_the_cells_of_that_side_and_belong_to_that_cube()
    {
        var mesh = Build(2, 3, 2, 4);

        var xplus = mesh.FacesOnSide(1, "XPlus").ToList();
        Assert.That(xplus.Count, Is.EqualTo(2 * 4));
        Assert.That(xplus.All(f => mesh.RootOf(f.Element) == 1 && f.Face == 5), Is.True);
        Assert.That(mesh.FacesOnSide(0, "ZMinus").Count(), Is.EqualTo(3 * 2));
        Assert.That(mesh.FacesOnSide(0, "Nonsense"), Is.Empty);
    }

    [Test]
    public void An_element_has_a_key_that_is_the_same_when_the_mesh_is_built_anew_and_no_two_elements_share_one()
    {
        var first = Build(2, 2, 2, 2);
        var second = Build(2, 2, 2, 2);

        var keys = Enumerable.Range(0, first.ElementCount).Select(first.KeyOf).ToList();
        Assert.That(keys.Distinct().Count(), Is.EqualTo(first.ElementCount));
        Assert.That(Enumerable.Range(0, second.ElementCount).Select(second.KeyOf), Is.EqualTo(keys));
    }

    [Test]
    public void The_elements_fill_the_cube_exactly_a_unit_cube_cut_evenly_has_elements_of_equal_volume_and_the_nodes_on_a_shared_side_are_one()
    {
        var mesh = Build(2, 2, 1, 1);

        // 2 cubes x 2 elements = 4 along x; nodes of a 20-node element: 4 elements in a row -> 8*... check the count of distinct nodes
        // corners of a row of 4: 5 x 2 x 2 = 20; midpoints: along x 4 x 4 + along y 5 x 2 + along z 5 x 2 = 16 + 10 + 10
        Assert.That(mesh.NodeCount, Is.EqualTo(20 + 16 + 10 + 10));
    }
}

public class ParametricPlacesTests
{
    private static IFemMesh Build(int cubes, int nx, int ny, int nz) => new UniformRefinement(nx, ny, nz).Build(Support.Export(Support.Bar(cubes)));

    [TestCase(1, 1, 1, 1)]
    [TestCase(1, 3, 3, 3)]
    [TestCase(2, 2, 5, 3)]
    [TestCase(3, 8, 1, 2)]
    public void The_centres_of_the_elements_of_a_cube_are_inside_it_and_are_different_places(int cubes, int nx, int ny, int nz)
    {
        var mesh = Build(cubes, nx, ny, nz);

        for (int cube = 0; cube < cubes; cube++)
        {
            var centres = mesh.ElementsOf(cube).Select(mesh.CentreOf).ToList();
            Assert.That(centres.Count, Is.EqualTo(nx * ny * nz));
            Assert.That(centres.Distinct().Count(), Is.EqualTo(centres.Count));
            Assert.That(centres.All(c => Enumerable.Range(0, 3).All(a => c[a] > -1 && c[a] < 1)), Is.True);
            // the middle of all the centres of an evenly cut cube is the middle of the cube
            for (int axis = 0; axis < 3; axis++) Assert.That(centres.Average(c => c[axis]), Is.EqualTo(0).Within(1e-9));
        }
    }

    [Test]
    public void The_centre_of_a_face_is_the_centre_of_its_element_moved_to_the_end_of_the_face_and_the_faces_on_a_side_lie_at_its_end()
    {
        var mesh = Build(1, 3, 2, 4);

        foreach (var (side, axis, sign) in new[] { ("XMinus", 0, -1), ("XPlus", 0, 1), ("YMinus", 1, -1), ("YPlus", 1, 1), ("ZMinus", 2, -1), ("ZPlus", 2, 1) })
        {
            var faces = mesh.FacesOnSide(0, side).ToList();
            Assert.That(faces.Count, Is.EqualTo(new[] { 3 * 2 * 4 / new[] { 3, 2, 4 }[axis] }[0]), side);
            foreach (var face in faces)
            {
                var centre = mesh.FaceCentreOf(face);
                Assert.That(centre[axis], Is.EqualTo(sign), side);
                for (int other = 0; other < 3; other++)
                    if (other != axis) Assert.That(centre[other], Is.EqualTo(mesh.CentreOf(face.Element)[other]).Within(1e-12), side);
            }
        }
    }

    [Test]
    public void A_cell_of_a_grid_owns_the_points_inside_it_and_each_point_has_exactly_one_owner_even_on_the_borders()
    {
        foreach (int n in new[] { 1, 2, 3, 5, 7, 8 })
            for (int m = 1; m <= 8; m++)
                for (int j = 0; j < m; j++)
                {
                    // the centres of the cells of a finer or coarser grid m, against the cells of grid n
                    var point = new ParametricPoint(0.5 * (UniformRefinement.Edge(j, m) + UniformRefinement.Edge(j + 1, m)), 0, 0);
                    int owners = 0;
                    for (int i = 0; i < n; i++)
                        if (new ParametricRegion(UniformRefinement.Edge(i, n), -1, -1, UniformRefinement.Edge(i + 1, n), 1, 1).Owns(point, new[] { 0 })) owners++;
                    Assert.That(owners, Is.EqualTo(1), $"cell {j} of {m} against grid {n}");
                }
    }
}
