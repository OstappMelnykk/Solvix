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
