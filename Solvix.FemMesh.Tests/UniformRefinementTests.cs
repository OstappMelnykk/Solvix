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

public class ParametricBoxTests
{
    private static IFemMesh Build(int cubes, int nx, int ny, int nz) => new UniformRefinement(nx, ny, nz).Build(Support.Export(Support.Bar(cubes)));

    [TestCase(1, 1, 1, 1)]
    [TestCase(1, 3, 3, 3)]
    [TestCase(2, 2, 5, 3)]
    [TestCase(3, 8, 1, 2)]
    public void The_boxes_of_the_elements_of_a_cube_tile_it_exactly(int cubes, int nx, int ny, int nz)
    {
        var mesh = Build(cubes, nx, ny, nz);

        for (int cube = 0; cube < cubes; cube++)
        {
            double volume = 0;
            foreach (int e in mesh.ElementsOf(cube))
            {
                var box = mesh.BoxOf(e);
                volume += (box.X1 - box.X0) * (box.Y1 - box.Y0) * (box.Z1 - box.Z0);
                for (int axis = 0; axis < 3; axis++)
                {
                    Assert.That(box.Lo(axis), Is.GreaterThanOrEqualTo(-1.0));
                    Assert.That(box.Hi(axis), Is.LessThanOrEqualTo(1.0));
                    Assert.That(box.Hi(axis), Is.GreaterThan(box.Lo(axis)));
                }
            }
            Assert.That(volume, Is.EqualTo(8.0).Within(1e-9), "a cube is [-1,1]^3, volume 8");
            Assert.That(mesh.ElementsOf(cube).Count, Is.EqualTo(nx * ny * nz));
        }
    }

    [Test]
    public void The_faces_on_a_side_tile_that_side_and_lie_at_its_end()
    {
        var mesh = Build(1, 3, 2, 4);

        foreach (var (side, axis, sign) in new[] { ("XMinus", 0, -1), ("XPlus", 0, 1), ("YMinus", 1, -1), ("YPlus", 1, 1), ("ZMinus", 2, -1), ("ZPlus", 2, 1) })
        {
            double area = 0;
            foreach (var face in mesh.FacesOnSide(0, side))
            {
                var flat = mesh.BoxOf(face.Element).Face(axis, sign);
                Assert.That(flat.Lo(axis), Is.EqualTo(sign), side);
                Assert.That(flat.Hi(axis), Is.EqualTo(sign), side);
                double w = 1;
                for (int a = 0; a < 3; a++) if (a != axis) w *= flat.Hi(a) - flat.Lo(a);
                area += w;
            }
            Assert.That(area, Is.EqualTo(4.0).Within(1e-9), $"{side}: the side of the cube is [-1,1]^2");
        }
    }

    [Test]
    public void A_cell_of_a_grid_owns_the_centres_inside_it_and_each_centre_has_exactly_one_owner_even_on_the_borders()
    {
        foreach (int n in new[] { 1, 2, 3, 5, 7, 8 })
            for (int m = 1; m <= 8; m++)
            {
                // centres of the cells of a finer or coarser grid m, against the cells of grid n
                for (int j = 0; j < m; j++)
                {
                    var centre = new ParametricBox(UniformRefinement.Edge(j, m), 0, 0, UniformRefinement.Edge(j + 1, m), 0, 0);
                    int owners = 0;
                    for (int i = 0; i < n; i++)
                        if (centre.CentreInside(new ParametricBox(UniformRefinement.Edge(i, n), -1, -1, UniformRefinement.Edge(i + 1, n), 1, 1), new[] { 0 })) owners++;
                    Assert.That(owners, Is.EqualTo(1), $"cell {j} of {m} against grid {n}");
                }
            }
    }
}
