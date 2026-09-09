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
}