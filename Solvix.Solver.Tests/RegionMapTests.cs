using Solvix.FemMesh;
using Solvix.FemMesh.Local;
using Solvix.Solver.Selections;
using static Solvix.Solver.Tests.SolverTestSupport;

namespace Solvix.Solver.Tests;

/// <summary>
/// What is set on the places of a cube is checked against the simplest possible model: the cube cut into a fine grid of cells, one number in each. A random
/// sequence of "put this on that box" and "clear that box" must leave the map and the model saying the same at every cell; a change must never go unreported.
/// </summary>
public class RegionMapTests
{
    private const int Fine = 10;                                       // cells per axis of the model: a cell is 1/5 of the cube's length (2 / 10)
    private const long Cell = 2 * Quantum.One / Fine;

    private static BoxShape Box(int x0, int y0, int z0, int x1, int y1, int z1) => new(new Cuboid(
        -Quantum.One + x0 * Cell, -Quantum.One + y0 * Cell, -Quantum.One + z0 * Cell, -Quantum.One + x1 * Cell, -Quantum.One + y1 * Cell, -Quantum.One + z1 * Cell));

    private static ParametricPoint CentreOf(int x, int y, int z) => new(-1 + (x + 0.5) * 2.0 / Fine, -1 + (y + 0.5) * 2.0 / Fine, -1 + (z + 0.5) * 2.0 / Fine);

    private static int Value(RegionMap<int> map, ParametricPoint at) => map.TryGetValueAt(at, out int v) ? v : 0;

    [TestCase(1, 3, false)]
    [TestCase(2, 3, false)]
    [TestCase(3, 3, false)]
    [TestCase(4, 2, true)]
    [TestCase(5, 2, true)]
    public void A_random_series_of_sets_and_clears_agrees_with_the_cell_by_cell_model(int seed, int values, bool flat)
    {
        var random = new Random(seed);
        var map = new RegionMap<int>();
        var model = new int[Fine, Fine, flat ? 1 : Fine];
        int zs = flat ? 1 : Fine;

        for (int step = 0; step < 250; step++)
        {
            int x0 = random.Next(0, Fine), x1 = random.Next(x0 + 1, Fine + 1);
            int y0 = random.Next(0, Fine), y1 = random.Next(y0 + 1, Fine + 1);
            int z0 = flat ? 0 : random.Next(0, Fine), z1 = flat ? 0 : random.Next(z0 + 1, Fine + 1);
            int value = random.Next(0, values + 1);                    // 0 clears
            var shape = flat ? new BoxShape(Box(x0, y0, 0, x1, y1, 0).Box with { Z0 = Quantum.One, Z1 = Quantum.One }) : Box(x0, y0, z0, x1, y1, z1);

            bool changes = false;
            for (int x = x0; x < x1; x++)
                for (int y = y0; y < y1; y++)
                    for (int z = flat ? 0 : z0; z < (flat ? 1 : z1); z++)
                        if (model[x, y, z] != value) { model[x, y, z] = value; changes = true; }
            bool reported = value == 0 ? map.Clear(shape) : map.Set(shape, value);

            if (changes) Assert.That(reported, Is.True, $"step {step}: a change is never missed");
            if (value != 0 && !changes) Assert.That(reported, Is.False, $"step {step}: a box that already has its value everywhere is no change");
            for (int x = 0; x < Fine; x++)
                for (int y = 0; y < Fine; y++)
                    for (int z = 0; z < zs; z++)
                        Assert.That(Value(map, flat ? CentreOf(x, y, 0) with { Z = 1 } : CentreOf(x, y, z)), Is.EqualTo(model[x, y, z]), $"step {step} cell {x},{y},{z}");
        }
    }

    [Test]
    public void Setting_and_clearing_the_same_cell_over_and_over_does_not_pile_up_layers()
    {
        var map = new RegionMap<int>();
        var cell = Box(2, 2, 2, 4, 4, 4);

        for (int i = 0; i < 50; i++)
        {
            map.Set(cell, 1);
            map.Clear(cell);
            map.Set(cell, 2);
        }

        Assert.That(map.Count, Is.EqualTo(1));
        Assert.That(Value(map, CentreOf(2, 2, 2)), Is.EqualTo(2));
        map.Clear(cell);
        Assert.That(map.Count, Is.EqualTo(0));
        Assert.That(map.Clear(cell), Is.False, "clearing what is empty changes nothing");
    }

    [Test]
    public void Setting_what_is_already_set_changes_nothing_but_another_value_does()
    {
        var map = new RegionMap<int>();
        map.Set(Box(0, 0, 0, 10, 10, 10), 1);

        Assert.That(map.Set(Box(2, 2, 2, 5, 5, 5), 1), Is.False);
        Assert.That(map.Clear(Box(0, 0, 0, 10, 10, 10)) , Is.True);
        Assert.That(map.Set(Box(2, 2, 2, 5, 5, 5), 1), Is.True);
        Assert.That(map.Set(Box(2, 2, 2, 5, 5, 5), 2), Is.True);
    }

    [Test]
    public void Two_boxes_that_share_a_border_never_both_own_a_place_on_it_and_the_end_of_the_cube_is_owned()
    {
        var map = new RegionMap<int>();
        map.Set(new BoxShape(new Cuboid(-Quantum.One, -Quantum.One, Quantum.One, 0, Quantum.One, Quantum.One)), 1);
        map.Set(new BoxShape(new Cuboid(0, -Quantum.One, Quantum.One, Quantum.One, Quantum.One, Quantum.One)), 2);

        Assert.That(Value(map, new ParametricPoint(0, 0, 1)), Is.EqualTo(2), "the border belongs to the box that starts there");
        Assert.That(Value(map, new ParametricPoint(1, 0, 1)), Is.EqualTo(2), "the end of the cube belongs to the last box");
        Assert.That(Value(map, new ParametricPoint(-1, 0, 1)), Is.EqualTo(1));
        Assert.That(Value(map, new ParametricPoint(-0.0000001, 0, 1)), Is.EqualTo(1));
    }

    // ---- shapes that are not boxes ----

    private static Shape Trapezoid() => new PolygonShape(2, Quantum.One, 0, 1, new[]
    {
        (-Quantum.One, -Quantum.One), (Quantum.One, -Quantum.One), (Quantum.One / 2, 0L), (-Quantum.One / 2, 0L)
    });

    [Test]
    public void A_trapezoid_owns_the_places_inside_it_and_its_border_and_nothing_else()
    {
        var shape = Trapezoid();

        Assert.That(shape.Contains(new ParametricPoint(0, -0.5, 1)), Is.True);
        Assert.That(shape.Contains(new ParametricPoint(0.9, -0.9, 1)), Is.True);
        Assert.That(shape.Contains(new ParametricPoint(0.9, -0.1, 1)), Is.False, "outside the slanted side");
        Assert.That(shape.Contains(new ParametricPoint(0, 0.2, 1)), Is.False, "above the top");
        Assert.That(shape.Contains(new ParametricPoint(0.5, 0, 1)), Is.True, "a corner counts");
        Assert.That(shape.Samples().All(shape.Contains), Is.True, "the samples are inside the shape");
    }

    [Test]
    public void A_wedge_owns_the_places_inside_it_and_its_samples_are_inside()
    {
        // half of a cube cut by a diagonal plane: a triangular prism
        var q = Quantum.One;
        var wedge = new HullShape(new[] { (-q, -q, -q), (q, -q, -q), (-q, q, -q), (-q, -q, q), (q, -q, q), (-q, q, q) });

        Assert.That(wedge.Contains(new ParametricPoint(-0.5, -0.5, 0)), Is.True);
        Assert.That(wedge.Contains(new ParametricPoint(0.8, 0.8, 0)), Is.False, "beyond the slanted face");
        Assert.That(wedge.Contains(new ParametricPoint(0, 0, 0)), Is.True, "on the slanted face");
        Assert.That(wedge.Contains(new ParametricPoint(0, 0, 1.2)), Is.False, "above the top");
        Assert.That(wedge.Samples().All(wedge.Contains), Is.True);
    }

    [Test]
    public void A_newer_layer_wins_whatever_the_shapes_and_a_clear_takes_a_shape_out_of_older_ones()
    {
        var map = new RegionMap<int>();
        var whole = new BoxShape(new Cuboid(-Quantum.One, -Quantum.One, Quantum.One, Quantum.One, Quantum.One, Quantum.One));
        map.Set(whole, 1);
        map.Set(Trapezoid(), 2);

        Assert.That(Value(map, new ParametricPoint(0, -0.5, 1)), Is.EqualTo(2), "in the trapezoid: the newer value");
        Assert.That(Value(map, new ParametricPoint(0.9, 0.9, 1)), Is.EqualTo(1), "outside it: the older one");
        Assert.That(map.Set(Trapezoid(), 2), Is.False, "the same again changes nothing");
        map.Clear(Trapezoid());
        Assert.That(Value(map, new ParametricPoint(0, -0.5, 1)), Is.EqualTo(0), "cleared there");
        Assert.That(Value(map, new ParametricPoint(0.9, 0.9, 1)), Is.EqualTo(1));
    }

    // ---- shapes of what a mesh really has ----

    public static IEnumerable<TestCaseData> Meshes()
    {
        yield return new TestCaseData(new UniformRefinement(3, 2, 2)).SetName("uniform");
        yield return new TestCaseData(new LocalRefinement(new[] { new RefinementStep(new[] { LocalRefinement.RootKey(1) }, 2, 2, 2) })).SetName("one cube refined");
        yield return new TestCaseData(new LocalRefinement(new[]
        {
            new RefinementStep(new[] { LocalRefinement.RootKey(0) }, 3, 3, 3, 1), new RefinementStep(new[] { LocalRefinement.RootKey(2) }, 2, 2, 2, 2)
        })).SetName("two cubes, wide zones");
    }

    [TestCaseSource(nameof(Meshes))]
    public void The_shape_of_every_face_on_a_side_owns_its_own_centre_and_no_other_faces_of_the_side(IMeshRefinement rule)
    {
        var mesh = rule.Build(Export(Bar(3)));

        for (int cube = 0; cube < 3; cube++)
            foreach (var side in ElementLocal.FaceNames)
            {
                var faces = mesh.FacesOnSide(cube, side).ToList();
                var shapes = faces.Select(f => Shape.OfFace(mesh, f)).ToList();
                for (int i = 0; i < faces.Count; i++)
                {
                    var centres = faces.Select(mesh.FaceCentreOf).ToList();
                    Assert.That(shapes[i].Contains(centres[i]), Is.True, $"cube {cube} {side}: a face owns its centre");
                    int owned = Enumerable.Range(0, faces.Count).Count(j => shapes[i].Contains(centres[j]));
                    Assert.That(owned, Is.EqualTo(1), $"cube {cube} {side}: a face owns no other face's centre");
                }
            }
    }

    [TestCaseSource(nameof(Meshes))]
    public void The_shape_of_every_element_owns_its_own_centre_and_no_other_element_of_the_cube(IMeshRefinement rule)
    {
        var mesh = rule.Build(Export(Bar(3)));

        for (int cube = 0; cube < 3; cube++)
        {
            var elements = mesh.ElementsOf(cube).ToList();
            foreach (int e in elements)
            {
                var shape = Shape.OfElement(mesh, e);
                int owned = elements.Count(o => shape.Contains(mesh.CentreOf(o)));
                Assert.That(shape.Contains(mesh.CentreOf(e)), Is.True, $"element {e} owns its centre");
                Assert.That(owned, Is.EqualTo(1), $"element {e} owns no other element's centre");
            }
        }
    }
}
