using System.Numerics;

namespace Solvix.Voxelization;

// Buckets triangles into a uniform grid's cells for fast "which triangles
// touch this cell" lookups - turns a scan from O(cells x triangles) into
// roughly O(cells + triangles). A separate concern from
// VoxelizationService's own job (deciding whether a specific cell counts
// as "included" via the SAT/ray-parity tests) - this class only knows how
// to build and query the spatial index itself, so swapping it for a
// different acceleration structure later (a BVH, an octree) wouldn't
// require VoxelizationService to change at all.
internal sealed class TriangleSpatialGrid
{
    private readonly Dictionary<(int, int, int), List<Triangle>> _buckets = new();
    private readonly Vector3 _boxMin;
    private readonly float _cellSize;
    private readonly GridDims _dims;

    private TriangleSpatialGrid(Vector3 boxMin, float cellSize, GridDims dims)
    {
        _boxMin = boxMin;
        _cellSize = cellSize;
        _dims = dims;
    }

    /// <param name="triangles">Every triangle of the imported mesh - each one gets bucketed into every grid cell its bounding box overlaps (possibly several).</param>
    /// <param name="boxMin">World-space minimum corner of the SAME voxelization grid these buckets index into - must match <see cref="VoxelizationResult.Origin"/>/the grid's own boxMin, not an independent bounding box.</param>
    /// <param name="cellSize">The grid's cell size - buckets are keyed by this same cell size, not an independent resolution.</param>
    /// <param name="dims">The grid's cell counts along each axis, used to clamp a coordinate's cell index to a valid bucket even if it falls slightly outside the grid.</param>
    /// <returns>A fully built, read-only index ready for <see cref="TrianglesNear"/> queries.</returns>
    public static TriangleSpatialGrid Build(List<Triangle> triangles, Vector3 boxMin, float cellSize, GridDims dims)
    {
        var grid = new TriangleSpatialGrid(boxMin, cellSize, dims);
        foreach (var triangle in triangles)
        {
            var ixMin = grid.CellIndexX(Math.Min(triangle.A.X, Math.Min(triangle.B.X, triangle.C.X)));
            var ixMax = grid.CellIndexX(Math.Max(triangle.A.X, Math.Max(triangle.B.X, triangle.C.X)));
            var iyMin = grid.CellIndexY(Math.Min(triangle.A.Y, Math.Min(triangle.B.Y, triangle.C.Y)));
            var iyMax = grid.CellIndexY(Math.Max(triangle.A.Y, Math.Max(triangle.B.Y, triangle.C.Y)));
            var izMin = grid.CellIndexZ(Math.Min(triangle.A.Z, Math.Min(triangle.B.Z, triangle.C.Z)));
            var izMax = grid.CellIndexZ(Math.Max(triangle.A.Z, Math.Max(triangle.B.Z, triangle.C.Z)));

            for (var ix = ixMin; ix <= ixMax; ix++)
            {
                for (var iy = iyMin; iy <= iyMax; iy++)
                {
                    for (var iz = izMin; iz <= izMax; iz++)
                    {
                        var key = (ix, iy, iz);
                        if (!grid._buckets.TryGetValue(key, out var bucket))
                        {
                            bucket = [];
                            grid._buckets[key] = bucket;
                        }
                        bucket.Add(triangle);
                    }
                }
            }
        }
        return grid;
    }

    /// <param name="ix">Cell index along X to look up.</param>
    /// <param name="iy">Cell index along Y to look up.</param>
    /// <param name="iz">Cell index along Z to look up.</param>
    /// <returns>Every triangle whose bounding box touched this cell during <see cref="Build"/> - an empty list, never null, if nothing was bucketed there.</returns>
    public IReadOnlyList<Triangle> TrianglesNear(int ix, int iy, int iz) =>
        _buckets.TryGetValue((ix, iy, iz), out var bucket) ? bucket : [];

    /// <param name="coord">A world-space X coordinate to convert.</param>
    /// <returns>The grid cell index along X that <paramref name="coord"/> falls into, clamped to a valid <c>[0, CountX)</c> index.</returns>
    public int CellIndexX(float coord) => AxisCellIndex(coord, _boxMin.X, _dims.CountX);
    /// <param name="coord">A world-space Y coordinate to convert.</param>
    /// <returns>The grid cell index along Y that <paramref name="coord"/> falls into, clamped to a valid <c>[0, CountY)</c> index.</returns>
    public int CellIndexY(float coord) => AxisCellIndex(coord, _boxMin.Y, _dims.CountY);
    /// <param name="coord">A world-space Z coordinate to convert.</param>
    /// <returns>The grid cell index along Z that <paramref name="coord"/> falls into, clamped to a valid <c>[0, CountZ)</c> index.</returns>
    public int CellIndexZ(float coord) => AxisCellIndex(coord, _boxMin.Z, _dims.CountZ);

    /// <param name="coord">A world-space coordinate along one axis.</param>
    /// <param name="minCoord">That same axis's component of the grid's own <see cref="_boxMin"/>.</param>
    /// <param name="count">That axis's cell count (<see cref="GridDims.CountX"/>/Y/Z), used to clamp the result into range.</param>
    /// <returns>The cell index <paramref name="coord"/> falls into along this one axis, clamped to <c>[0, count)</c> so a point slightly outside the grid (floating-point edge cases) still resolves to the nearest real cell instead of an out-of-range index.</returns>
    private int AxisCellIndex(float coord, float minCoord, int count)
    {
        var index = (int)Math.Floor((coord - minCoord) / _cellSize);
        return Math.Min(count - 1, Math.Max(0, index));
    }
}