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

    public IReadOnlyList<Triangle> TrianglesNear(int ix, int iy, int iz) =>
        _buckets.TryGetValue((ix, iy, iz), out var bucket) ? bucket : [];

    public int CellIndexX(float coord) => AxisCellIndex(coord, _boxMin.X, _dims.CountX);
    public int CellIndexY(float coord) => AxisCellIndex(coord, _boxMin.Y, _dims.CountY);
    public int CellIndexZ(float coord) => AxisCellIndex(coord, _boxMin.Z, _dims.CountZ);

    private int AxisCellIndex(float coord, float minCoord, int count)
    {
        var index = (int)Math.Floor((coord - minCoord) / _cellSize);
        return Math.Min(count - 1, Math.Max(0, index));
    }
}