using Solvix.FemMesh;
using Solvix.Solver.Selections;

namespace Solvix.Solver.Tests;

/// <summary>
/// The regions of the setup are checked against the simplest possible model: the cube cut into a fine grid of cells, one number in each. A random
/// sequence of "put this on that box" and "clear that box" must leave the region map and the model saying the same at every cell, never overlap, and report a change exactly when
/// the model changed.
/// </summary>
public class RegionMapTests
{
    private const int Fine = 10;                                       // cells per axis of the model: a cell is 1/5 of the cube's length (2 / 10)
    private const long Cell = 2 * Quantum.One / Fine;

    private static Cuboid Box(int x0, int y0, int z0, int x1, int y1, int z1) =>
        new(-Quantum.One + x0 * Cell, -Quantum.One + y0 * Cell, -Quantum.One + z0 * Cell, -Quantum.One + x1 * Cell, -Quantum.One + y1 * Cell, -Quantum.One + z1 * Cell);

    private static ParametricPoint CentreOf(int x, int y, int z) => new(
        -1 + (x + 0.5) * 2.0 / Fine, -1 + (y + 0.5) * 2.0 / Fine, -1 + (z + 0.5) * 2.0 / Fine);

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
            var box = flat ? Box(x0, y0, 0, x1, y1, 0) with { Z0 = Quantum.One, Z1 = Quantum.One } : Box(x0, y0, z0, x1, y1, z1);

            bool changes = false;
            for (int x = x0; x < x1; x++)
                for (int y = y0; y < y1; y++)
                    for (int z = flat ? 0 : z0; z < (flat ? 1 : z1); z++)
                        if (model[x, y, z] != value) { model[x, y, z] = value; changes = true; }
            bool reported = value == 0 ? map.Clear(box) : map.Set(box, value);

            Assert.That(reported, Is.EqualTo(changes), $"step {step}: the change is reported exactly when something changed");
            for (int x = 0; x < Fine; x++)
                for (int y = 0; y < Fine; y++)
                    for (int z = 0; z < zs; z++)
                        Assert.That(Value(map, flat ? CentreOf(x, y, 0) with { Z = 1 } : CentreOf(x, y, z)), Is.EqualTo(model[x, y, z]), $"step {step} cell {x},{y},{z}");
            var entries = map.Entries;
            for (int i = 0; i < entries.Count; i++)
                for (int j = i + 1; j < entries.Count; j++)
                    Assert.That(entries[i].Box.Overlaps(entries[j].Box), Is.False, $"step {step}: regions {i} and {j} overlap");
        }
    }

    [Test]
    public void A_region_that_was_cut_and_put_back_is_one_box_again()
    {
        var map = new RegionMap<int>();
        map.Set(Box(0, 0, 0, 10, 10, 10), 1);
        map.Clear(Box(4, 4, 4, 6, 6, 6));
        Assert.That(map.Count, Is.GreaterThan(1));

        map.Set(Box(4, 4, 4, 6, 6, 6), 1);

        Assert.That(map.Count, Is.EqualTo(1));
        Assert.That(map.Entries[0].Box, Is.EqualTo(Box(0, 0, 0, 10, 10, 10)));
    }

    [Test]
    public void Setting_what_is_already_set_or_clearing_what_is_empty_changes_nothing()
    {
        var map = new RegionMap<int>();
        map.Set(Box(0, 0, 0, 10, 10, 10), 1);
        var before = map.Entries.ToList();

        Assert.That(map.Set(Box(2, 2, 2, 5, 5, 5), 1), Is.False);
        Assert.That(map.Clear(Box(12, 12, 12, 15, 15, 15)), Is.False);
        Assert.That(map.Entries, Is.EqualTo(before));
        Assert.That(map.Set(Box(2, 2, 2, 5, 5, 5), 2), Is.True, "another value is a change");
    }

    [Test]
    public void Two_regions_that_share_a_border_never_both_own_a_place_on_it_and_the_end_of_the_cube_is_owned()
    {
        var map = new RegionMap<int>();
        var left = new Cuboid(-Quantum.One, -Quantum.One, Quantum.One, 0, Quantum.One, Quantum.One);
        var right = new Cuboid(0, -Quantum.One, Quantum.One, Quantum.One, Quantum.One, Quantum.One);
        map.Set(left, 1);
        map.Set(right, 2);

        Assert.That(Value(map, new ParametricPoint(0, 0, 1)), Is.EqualTo(2), "the border belongs to the region that starts there");
        Assert.That(Value(map, new ParametricPoint(1, 0, 1)), Is.EqualTo(2), "the end of the cube belongs to the last region");
        Assert.That(Value(map, new ParametricPoint(-1, 0, 1)), Is.EqualTo(1));
        Assert.That(Value(map, new ParametricPoint(-0.0000001, 0, 1)), Is.EqualTo(1));
    }
}
