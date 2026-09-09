using System.Numerics;

namespace Solvix.Voxelization.Tests;

public class VoxelizationServiceTests
{
    private VoxelizationService _voxelizationService = null!;

    [SetUp]
    public void SetUp()
    {
        _voxelizationService = new VoxelizationService();
    }

    // Axis-aligned box centered at the origin, sized sx x sy x sz - the
    // watertight 12-triangle surface any box mesh has.
    private static ImportedSurfaceMesh Box(float sx, float sy, float sz)
    {
        float hx = sx / 2, hy = sy / 2, hz = sz / 2;
        Vector3[] vertices =
        [
            new(-hx, -hy, -hz), new(hx, -hy, -hz), new(hx, hy, -hz), new(-hx, hy, -hz),
            new(-hx, -hy, hz), new(hx, -hy, hz), new(hx, hy, hz), new(-hx, hy, hz)
        ];
        int[] indices =
        [
            0, 1, 2, 0, 2, 3, // back
            5, 4, 7, 5, 7, 6, // front
            4, 0, 3, 4, 3, 7, // left
            1, 5, 6, 1, 6, 2, // right
            3, 2, 6, 3, 6, 7, // top
            4, 5, 1, 4, 1, 0 // bottom
        ];
        return new ImportedSurfaceMesh(vertices, indices);
    }

    // Two separate 1x1x1 boxes, several units apart along X - combined
    // into one mesh so their shared bounding box (and therefore the grid)
    // includes the real empty gap between them. Any occupied cell in that
    // gap that isn't touching (or adjacent to) either actual box is
    // exactly the "ghost cube" bug this is meant to catch: a false
    // positive from the ray-parity inside test, not from anything the
    // mesh actually contains there.
    private static ImportedSurfaceMesh TwoBoxesWithGap()
    {
        var boxA = Box(1, 1, 1);
        var boxB = Box(1, 1, 1);
        var offsetA = new Vector3(-3, 0, 0);
        var offsetB = new Vector3(3, 0, 0);
        var vertices = boxA.Vertices.Select(v => v + offsetA)
            .Concat(boxB.Vertices.Select(v => v + offsetB))
            .ToArray();
        var indices = boxA.Indices
            .Concat(boxB.Indices.Select(i => i + boxA.Vertices.Count))
            .ToArray();
        return new ImportedSurfaceMesh(vertices, indices);
    }

    // Rotates every vertex around the origin - used to check that the
    // ghost-cube fix holds regardless of orientation, not just for
    // axis-aligned meshes. The voxel grid itself never rotates with the
    // mesh (it's always aligned to WORLD axes - see docs on the rotate
    // gizmo), so a rotated mesh's faces/edges can land exactly on grid
    // boundaries via a completely different SAT axis than an unrotated
    // mesh would (see TriangleIntersectsBox's comment - this is why the
    // boundary-exact check covers all 13 axes, not just the 3 box axes).
    private static ImportedSurfaceMesh Rotated(ImportedSurfaceMesh mesh, float angleRadians, Vector3 axis)
    {
        var rotation = Quaternion.CreateFromAxisAngle(Vector3.Normalize(axis), angleRadians);
        var vertices = mesh.Vertices.Select(v => Vector3.Transform(v, rotation)).ToArray();
        return new ImportedSurfaceMesh(vertices, mesh.Indices);
    }

    // Number of 6-connected (face-adjacent) groups among the given cells -
    // used instead of exact coordinates for the rotated case below, since
    // rotation makes the exact occupied cell indices impractical to
    // predict by hand, but "how many separate blobs" is still meaningful:
    // two physically separate boxes should never produce more than 2.
    private static int CountConnectedComponents(List<(int X, int Y, int Z)> cells)
    {
        var indexOf = new Dictionary<(int, int, int), int>();
        for (var i = 0; i < cells.Count; i++)
        {
            indexOf[cells[i]] = i;
        }
        var parent = Enumerable.Range(0, cells.Count).ToArray();
        int Find(int x)
        {
            while (parent[x] != x)
            {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        }
        (int, int, int)[] faceOffsets = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];
        for (var i = 0; i < cells.Count; i++)
        {
            var (x, y, z) = cells[i];
            foreach (var (dx, dy, dz) in faceOffsets)
            {
                if (indexOf.TryGetValue((x + dx, y + dy, z + dz), out var j))
                {
                    var ri = Find(i);
                    var rj = Find(j);
                    if (ri != rj)
                    {
                        parent[ri] = rj;
                    }
                }
            }
        }
        return Enumerable.Range(0, cells.Count).Select(Find).Distinct().Count();
    }

    // All occupied cells' world-space centers, derived from the grid the
    // same way solvix-web/src/app/geometry/voxel-grid-contract.ts does -
    // Origin + cellSize*(index + 0.5) per axis, only for cells IsOccupied
    // says are set.
    private static List<Vector3> OccupiedCenters(VoxelizationResult result)
    {
        var centers = new List<Vector3>();
        for (var ix = 0; ix < result.CountX; ix++)
        {
            for (var iy = 0; iy < result.CountY; iy++)
            {
                for (var iz = 0; iz < result.CountZ; iz++)
                {
                    if (!result.IsOccupied(ix, iy, iz))
                    {
                        continue;
                    }
                    centers.Add(new Vector3(
                        result.Origin.X + result.CellSize * (ix + 0.5f),
                        result.Origin.Y + result.CellSize * (iy + 0.5f),
                        result.Origin.Z + result.CellSize * (iz + 0.5f)));
                }
            }
        }
        return centers;
    }

    private static int OccupiedCount(VoxelizationResult result) => OccupiedCenters(result).Count;

    [Test]
    public void Covers_a_1x1x1_box_centered_at_the_origin_with_exactly_one_unit_cube()
    {
        var result = _voxelizationService.Voxelize(Box(1, 1, 1));

        Assert.That(result.CellSize, Is.EqualTo(1));
        Assert.That(result.CountX, Is.EqualTo(1));
        Assert.That(result.CountY, Is.EqualTo(1));
        Assert.That(result.CountZ, Is.EqualTo(1));
        var centers = OccupiedCenters(result);
        Assert.That(centers, Has.Count.EqualTo(1));
        Assert.That(centers[0].X, Is.EqualTo(0).Within(1e-4));
        Assert.That(centers[0].Y, Is.EqualTo(0).Within(1e-4));
        Assert.That(centers[0].Z, Is.EqualTo(0).Within(1e-4));
    }

    [Test]
    public void Covers_an_elongated_box_with_one_unit_cube_per_unit_of_length_along_the_long_axis()
    {
        var result = _voxelizationService.Voxelize(Box(3, 1, 1));

        Assert.That(result.CountX, Is.EqualTo(3));
        var xs = OccupiedCenters(result).Select(c => Math.Round(c.X)).OrderBy(x => x).ToArray();
        Assert.That(xs, Is.EqualTo(new double[] { -1, 0, 1 }));
    }

    [Test]
    public void Scaling_the_mesh_not_the_cube_size_is_what_changes_the_resulting_density()
    {
        var box = Box(1, 1, 1);
        var scaled = new ImportedSurfaceMesh(box.Vertices.Select(v => v * 4).ToArray(), box.Indices);

        var result = _voxelizationService.Voxelize(scaled);

        Assert.That(result.CellSize, Is.EqualTo(1));
        Assert.That(OccupiedCount(result), Is.EqualTo(64)); // 4x4x4 unit cubes
    }

    [Test]
    public void Returns_no_cubes_for_a_mesh_with_no_triangles()
    {
        var result = _voxelizationService.Voxelize(new ImportedSurfaceMesh(Array.Empty<Vector3>(), Array.Empty<int>()));

        Assert.That(result.CountX, Is.EqualTo(0));
        Assert.That(result.Occupancy, Is.Empty);
    }

    // A bounding-box length with a fractional remainder (2.3 here) needs
    // Ceiling(2.3) = 3 cells to be FULLY covered - 2 cells only spans 2.0
    // units, leaving 0.3 units of the body uncovered. This is the same
    // density-scaling fact documented in VoxelizationService: proportional
    // scaling of the two non-longest axes essentially never lands on a
    // whole number of cells, so Ceiling (not truncation) is what keeps the
    // conservative-coverage guarantee.
    [Test]
    public void Uses_exactly_ceiling_of_length_cells_for_a_bounding_box_with_a_fractional_length()
    {
        var result = _voxelizationService.Voxelize(Box(2.3f, 1, 1));

        Assert.That(result.CountX, Is.EqualTo(3));
        var xs = OccupiedCenters(result).Select(c => c.X).OrderBy(x => x).ToArray();
        Assert.That(xs[0], Is.EqualTo(-0.65).Within(1e-4));
        Assert.That(xs[1], Is.EqualTo(0.35).Within(1e-4));
        Assert.That(xs[2], Is.EqualTo(1.35).Within(1e-4));
    }

    // Regression: a bounding-box length only SLIGHTLY over one cell (1.14
    // here) needs 2 cells (Ceiling(1.14) = 2), but the 2nd cell's CENTER
    // (boxMin + 1.5) falls PAST boxMax (boxMin + 1.14) even though the
    // cell's own span [boxMin+1, boxMin+2) still overlaps the body's
    // [boxMin+1, boxMin+1.14] sliver. A loop that steps a coordinate and
    // stops once it exceeds boxMax silently drops this cell, leaving part
    // of the body uncovered - defeats conservative voxelization's whole
    // guarantee (union of cubes >= body volume).
    [Test]
    public void Covers_the_full_height_when_the_bounding_box_barely_exceeds_one_cell()
    {
        var result = _voxelizationService.Voxelize(Box(1, 1.14f, 1));

        Assert.That(result.CountY, Is.EqualTo(2));
        // hy = 0.57, so boxMin.Y = -0.57; cell centers are boxMin.Y + 0.5 +
        // i*1 for i in [0, 1] -> -0.07 and 0.93.
        var ys = OccupiedCenters(result).Select(c => c.Y).OrderBy(y => y).ToArray();
        Assert.That(ys, Has.Length.EqualTo(2));
        Assert.That(ys[0], Is.EqualTo(-0.07).Within(1e-4));
        Assert.That(ys[1], Is.EqualTo(0.93).Within(1e-4));
    }

    [Test]
    public void Throws_when_the_mesh_is_scaled_far_too_large_relative_to_the_unit_cube()
    {
        var box = Box(1, 1, 1);
        var scaled = new ImportedSurfaceMesh(box.Vertices.Select(v => v * 200).ToArray(), box.Indices);

        Assert.Throws<VoxelizationTooLargeException>(() => _voxelizationService.Voxelize(scaled));
    }

    // Regression: countX*countY*countZ used to be multiplied as int32.
    // Each axis alone (900,000) sits AT the cap - not over it, so nothing
    // clamps any single axis - but their product (~7.29e17) overflows
    // int32 many times over. The old code let that silently wrap to some
    // unrelated (possibly small, possibly negative) int and slip past the
    // `estimatedCells > MaxCells` check entirely, corrupting everything
    // downstream (occupancy array size, CellIndex math) instead of
    // cleanly reporting "too large".
    [Test]
    public void Throws_instead_of_silently_overflowing_when_all_three_axis_counts_multiply_past_int32_range()
    {
        var scaled = Box(900_000, 900_000, 900_000);

        Assert.Throws<VoxelizationTooLargeException>(() => _voxelizationService.Voxelize(scaled));
    }

    [Test]
    public void Stops_early_via_the_cancellation_token_instead_of_finishing_a_cancelled_request()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.Throws<OperationCanceledException>(() => _voxelizationService.Voxelize(Box(3, 3, 3), cts.Token));
    }

    // Regression: a false positive from the ray-parity inside test (see
    // InsideTestRays' comment) produces an isolated occupied cell with no
    // connection to either real solid - reported as a "ghost cube"
    // floating in otherwise-empty space on real architectural imports
    // (lots of triangulated rectangular faces = lots of diagonal edges a
    // ray can graze). Two 1x1x1 boxes several units apart puts a real,
    // unambiguous gap inside the grid - exactly two cells (one per box)
    // should end up occupied, and nothing in between. (An earlier version
    // of this test asserted "every occupied cell has an occupied
    // neighbor" instead, which is wrong for this mesh on its own terms:
    // each box is exactly one cell, so its own cell correctly has no
    // neighbor either - that's a small solid object, not a bug.)
    [Test]
    public void Does_not_produce_an_isolated_ghost_cell_in_the_empty_gap_between_two_separate_solids()
    {
        var result = _voxelizationService.Voxelize(TwoBoxesWithGap());

        var occupied = new List<(int X, int Y, int Z)>();
        for (var ix = 0; ix < result.CountX; ix++)
        {
            for (var iy = 0; iy < result.CountY; iy++)
            {
                for (var iz = 0; iz < result.CountZ; iz++)
                {
                    if (result.IsOccupied(ix, iy, iz))
                    {
                        occupied.Add((ix, iy, iz));
                    }
                }
            }
        }

        // boxA at x=-3, boxB at x=+3 (see TwoBoxesWithGap), each 1x1x1 -
        // exactly one cell each, nothing in the 5 cells of genuinely empty
        // space between them (ix 1..5 out of 0..6).
        Assert.That(occupied, Has.Count.EqualTo(2), $"Expected exactly 2 occupied cells (one per box), got: [{string.Join(", ", occupied)}]");
        Assert.That(occupied, Has.Some.EqualTo((0, 0, 0)));
        Assert.That(occupied, Has.Some.EqualTo((result.CountX - 1, 0, 0)));
    }

    // Same regression as above, but rotated 45 degrees - the voxel grid
    // never rotates with the mesh (see Rotated's comment), so a mesh that
    // rotation makes the grid's boundary-exact coincidence lands on a
    // DIFFERENT one of the 13 SAT axes than the unrotated case exercises
    // (edge-cross or the triangle's own normal, not one of the 3 box
    // axes) - this is exactly the report that motivated widening the
    // boundary-exact check to all 13 axes instead of just those 3.
    // Rotation preserves distances, so the two boxes stay just as
    // separate as in the unrotated case - "at most 2 connected blobs" is
    // still the right invariant, just checked via connectivity instead of
    // exact cell coordinates, which rotation makes impractical to predict
    // by hand.
    [Test]
    public void Does_not_produce_an_isolated_ghost_cell_when_the_gap_mesh_is_rotated_45_degrees()
    {
        var rotated = Rotated(TwoBoxesWithGap(), MathF.PI / 4, new Vector3(0, 1, 0));
        var result = _voxelizationService.Voxelize(rotated);

        var occupied = new List<(int X, int Y, int Z)>();
        for (var ix = 0; ix < result.CountX; ix++)
        {
            for (var iy = 0; iy < result.CountY; iy++)
            {
                for (var iz = 0; iz < result.CountZ; iz++)
                {
                    if (result.IsOccupied(ix, iy, iz))
                    {
                        occupied.Add((ix, iy, iz));
                    }
                }
            }
        }

        var componentCount = CountConnectedComponents(occupied);
        Assert.That(componentCount, Is.LessThanOrEqualTo(2),
            $"Expected at most 2 connected components (one per box), got {componentCount}. Occupied cells: [{string.Join(", ", occupied)}]");
    }
}