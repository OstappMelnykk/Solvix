using System.Numerics;

namespace Solvix.Voxelization;

// All logic for turning a triangle mesh into a set of unit voxels lives
// here: spatial-grid-accelerated SAT triangle-vs-box test for cubes the
// surface actually touches, plus a grid-accelerated ray-parity test for
// cubes fully enclosed by the surface. Internal - see Voxelizer.cs for
// this project's sole public entry point.
internal sealed class VoxelizationService
{
    // The cube side is always literally 1 - density is achieved by the
    // caller scaling the mesh's vertices before calling Voxelize(), never
    // by a parameter here.
    private const float UnitCubeSize = 1.0f;

    // Hard cap on grid cells so a mesh scaled far too large relative to the
    // unit cube fails fast instead of hanging.
    private const int MaxCells = 900_000;

    // Ray direction for the inside/outside parity test - arbitrary but
    // non-axis-aligned, to sidestep the common degenerate case of grazing
    // exactly along a face/edge.
    private static readonly Vector3 InsideTestDirection = Vector3.Normalize(new Vector3(0.9137f, 0.2711f, 0.3053f));

    private readonly record struct Triangle(Vector3 A, Vector3 B, Vector3 C);
    private readonly record struct GridDims(int CountX, int CountY, int CountZ);

    public VoxelizationResult Voxelize(ImportedSurfaceMesh mesh)
    {
        var triangles = CollectTriangles(mesh);
        if (triangles.Count == 0)
        {
            return new VoxelizationResult(Vector3.Zero, UnitCubeSize, 0, 0, 0, []);
        }

        var (boxMin, boxMax) = BoundingBox(triangles);
        const float cellSize = UnitCubeSize;
        const float half = cellSize / 2;

        // The FE only ever controls "density" - how many unit cubes the
        // OBJECT'S LONGEST bounding-box axis should span (see
        // ImportedReferenceRenderService.setDensity) - by scaling the whole
        // mesh so that axis becomes exactly `density` world units before
        // sending it here. Proportions are preserved, so the OTHER two axes
        // get scaled by that same factor - but the file's original
        // proportions are essentially never round numbers, so those two
        // axes come out to some arbitrary fractional length (e.g. 3.666
        // units), not a whole number of cubes. Ceiling is what turns that
        // into a cell count: 3.666 -> 4, never 3 - rounding down (or
        // truncating) would leave a real sliver of the body (that last
        // 0.666 units) with no cube over it at all, which breaks
        // conservative voxelization's entire guarantee (union of cubes >=
        // body volume). This is also why total cell count grows roughly as
        // the CUBE of density (10x density -> ~1000x cells, not 10x) and
        // why that count is checked against MaxCells below - "more detail"
        // and "hitting the cell cap" are the same knob.
        var countX = Math.Max(1, (int)Math.Ceiling((boxMax.X - boxMin.X) / cellSize));
        var countY = Math.Max(1, (int)Math.Ceiling((boxMax.Y - boxMin.Y) / cellSize));
        var countZ = Math.Max(1, (int)Math.Ceiling((boxMax.Z - boxMin.Z) / cellSize));
        var estimatedCells = countX * countY * countZ;
        if (estimatedCells > MaxCells)
        {
            throw new VoxelizationTooLargeException(estimatedCells, MaxCells);
        }

        var dims = new GridDims(countX, countY, countZ);
        var grid = BuildTriangleGrid(triangles, boxMin, cellSize, dims);

        // Iterate by CELL INDEX (0..countX/Y/Z-1), not by stepping a
        // coordinate until it exceeds boxMax - a cell's CENTER can
        // legitimately land past boxMax while the cell itself still needs
        // testing. E.g. a 1.14-unit span needs 2 cells (countY =
        // Ceiling(1.14) = 2): cell 1 spans [boxMin, boxMin+1), cell 2 spans
        // [boxMin+1, boxMin+2) and its center is boxMin+1.5 - past
        // boxMax = boxMin+1.14, but the body's own [boxMin+1, boxMin+1.14]
        // sliver still sits inside cell 2's span and must be covered.
        // Stepping-and-comparing against boxMax silently dropped exactly
        // this cell, leaving a sliver of the body uncovered - conservative
        // voxelization's whole guarantee (union of cubes >= body volume)
        // depends on visiting every cell the grid dimensions say exist.
        var occupancy = new byte[(estimatedCells + 7) / 8];
        for (var ix = 0; ix < countX; ix++)
        {
            var x = boxMin.X + half + ix * cellSize;
            for (var iy = 0; iy < countY; iy++)
            {
                var y = boxMin.Y + half + iy * cellSize;
                for (var iz = 0; iz < countZ; iz++)
                {
                    var z = boxMin.Z + half + iz * cellSize;
                    var center = new Vector3(x, y, z);
                    if (IsCubeIncluded(ix, iy, iz, center, half, boxMin, cellSize, dims, grid))
                    {
                        var index = VoxelizationResult.CellIndex(ix, iy, iz, countX, countY);
                        occupancy[index / 8] |= (byte)(1 << (index % 8));
                    }
                }
            }
        }

        return new VoxelizationResult(boxMin, cellSize, countX, countY, countZ, occupancy);
    }

    private static List<Triangle> CollectTriangles(ImportedSurfaceMesh mesh)
    {
        var triangles = new List<Triangle>(mesh.Indices.Count / 3);
        for (var i = 0; i + 2 < mesh.Indices.Count; i += 3)
        {
            var a = mesh.Vertices[mesh.Indices[i]];
            var b = mesh.Vertices[mesh.Indices[i + 1]];
            var c = mesh.Vertices[mesh.Indices[i + 2]];
            triangles.Add(new Triangle(a, b, c));
        }
        return triangles;
    }

    private static (Vector3 min, Vector3 max) BoundingBox(List<Triangle> triangles)
    {
        var min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
        var max = new Vector3(float.MinValue, float.MinValue, float.MinValue);
        foreach (var triangle in triangles)
        {
            min = Vector3.Min(min, Vector3.Min(triangle.A, Vector3.Min(triangle.B, triangle.C)));
            max = Vector3.Max(max, Vector3.Max(triangle.A, Vector3.Max(triangle.B, triangle.C)));
        }
        return (min, max);
    }

    private static int AxisCellIndex(float coord, float minCoord, float cellSize, int count)
    {
        var index = (int)Math.Floor((coord - minCoord) / cellSize);
        return Math.Min(count - 1, Math.Max(0, index));
    }

    // Buckets each triangle into every grid cell its own AABB overlaps -
    // turns the scan from O(cells x triangles) into roughly O(cells +
    // triangles).
    private static Dictionary<(int, int, int), List<Triangle>> BuildTriangleGrid(
        List<Triangle> triangles, Vector3 boxMin, float cellSize, GridDims dims)
    {
        var grid = new Dictionary<(int, int, int), List<Triangle>>();
        foreach (var triangle in triangles)
        {
            var ixMin = AxisCellIndex(Math.Min(triangle.A.X, Math.Min(triangle.B.X, triangle.C.X)), boxMin.X, cellSize, dims.CountX);
            var ixMax = AxisCellIndex(Math.Max(triangle.A.X, Math.Max(triangle.B.X, triangle.C.X)), boxMin.X, cellSize, dims.CountX);
            var iyMin = AxisCellIndex(Math.Min(triangle.A.Y, Math.Min(triangle.B.Y, triangle.C.Y)), boxMin.Y, cellSize, dims.CountY);
            var iyMax = AxisCellIndex(Math.Max(triangle.A.Y, Math.Max(triangle.B.Y, triangle.C.Y)), boxMin.Y, cellSize, dims.CountY);
            var izMin = AxisCellIndex(Math.Min(triangle.A.Z, Math.Min(triangle.B.Z, triangle.C.Z)), boxMin.Z, cellSize, dims.CountZ);
            var izMax = AxisCellIndex(Math.Max(triangle.A.Z, Math.Max(triangle.B.Z, triangle.C.Z)), boxMin.Z, cellSize, dims.CountZ);

            for (var ix = ixMin; ix <= ixMax; ix++)
            {
                for (var iy = iyMin; iy <= iyMax; iy++)
                {
                    for (var iz = izMin; iz <= izMax; iz++)
                    {
                        var key = (ix, iy, iz);
                        if (!grid.TryGetValue(key, out var bucket))
                        {
                            bucket = [];
                            grid[key] = bucket;
                        }
                        bucket.Add(triangle);
                    }
                }
            }
        }
        return grid;
    }

    // Separating-axis test (Akenine-Moller) for triangle vs axis-aligned
    // box - needed on top of the inside test because a cube whose CENTER is
    // outside the body can still have the surface cut through one of its
    // corners/edges.
    private static bool TriangleIntersectsBox(Triangle triangle, Vector3 boxCenter, float boxHalf)
    {
        var v0 = triangle.A - boxCenter;
        var v1 = triangle.B - boxCenter;
        var v2 = triangle.C - boxCenter;

        bool OverlapsOnAxis(Vector3 axis)
        {
            if (axis.LengthSquared() < 1e-12f)
            {
                return true;
            }
            var p0 = Vector3.Dot(v0, axis);
            var p1 = Vector3.Dot(v1, axis);
            var p2 = Vector3.Dot(v2, axis);
            var triMin = Math.Min(p0, Math.Min(p1, p2));
            var triMax = Math.Max(p0, Math.Max(p1, p2));
            var r = boxHalf * (Math.Abs(axis.X) + Math.Abs(axis.Y) + Math.Abs(axis.Z));
            return triMin <= r && triMax >= -r;
        }

        Vector3[] boxAxes = [new(1, 0, 0), new(0, 1, 0), new(0, 0, 1)];
        foreach (var axis in boxAxes)
        {
            if (!OverlapsOnAxis(axis))
            {
                return false;
            }
        }

        Vector3[] edges = [v1 - v0, v2 - v1, v0 - v2];
        foreach (var edge in edges)
        {
            foreach (var boxAxis in boxAxes)
            {
                if (!OverlapsOnAxis(Vector3.Cross(boxAxis, edge)))
                {
                    return false;
                }
            }
        }

        var triangleNormal = Vector3.Cross(edges[0], edges[1]);
        return OverlapsOnAxis(triangleNormal);
    }

    // Parity ray-cast test: a point is inside a closed surface iff a ray
    // from it crosses the surface an odd number of times. Walks the same
    // uniform grid via 3D DDA (Amanatides-Woo) so only triangles in cells
    // the ray actually passes through get tested.
    private static bool IsPointInsideViaGrid(
        Vector3 point, Vector3 boxMin, float cellSize, GridDims dims, Dictionary<(int, int, int), List<Triangle>> grid)
    {
        var direction = InsideTestDirection;
        var ix = AxisCellIndex(point.X, boxMin.X, cellSize, dims.CountX);
        var iy = AxisCellIndex(point.Y, boxMin.Y, cellSize, dims.CountY);
        var iz = AxisCellIndex(point.Z, boxMin.Z, cellSize, dims.CountZ);

        var stepX = direction.X > 0 ? 1 : -1;
        var stepY = direction.Y > 0 ? 1 : -1;
        var stepZ = direction.Z > 0 ? 1 : -1;

        float TMaxFor(float origin, float minCoord, int index, int step, float component)
        {
            if (component == 0)
            {
                return float.PositiveInfinity;
            }
            var boundary = minCoord + (step > 0 ? index + 1 : index) * cellSize;
            return (boundary - origin) / component;
        }
        float TDeltaFor(float component) => component == 0 ? float.PositiveInfinity : Math.Abs(cellSize / component);

        var tMaxX = TMaxFor(point.X, boxMin.X, ix, stepX, direction.X);
        var tMaxY = TMaxFor(point.Y, boxMin.Y, iy, stepY, direction.Y);
        var tMaxZ = TMaxFor(point.Z, boxMin.Z, iz, stepZ, direction.Z);
        var tDeltaX = TDeltaFor(direction.X);
        var tDeltaY = TDeltaFor(direction.Y);
        var tDeltaZ = TDeltaFor(direction.Z);

        var candidates = new HashSet<Triangle>();
        var maxSteps = dims.CountX + dims.CountY + dims.CountZ + 1;

        for (var step = 0; step <= maxSteps; step++)
        {
            if (grid.TryGetValue((ix, iy, iz), out var bucket))
            {
                foreach (var triangle in bucket)
                {
                    candidates.Add(triangle);
                }
            }

            if (tMaxX <= tMaxY && tMaxX <= tMaxZ)
            {
                ix += stepX;
                tMaxX += tDeltaX;
            }
            else if (tMaxY <= tMaxZ)
            {
                iy += stepY;
                tMaxY += tDeltaY;
            }
            else
            {
                iz += stepZ;
                tMaxZ += tDeltaZ;
            }
            if (ix < 0 || ix >= dims.CountX || iy < 0 || iy >= dims.CountY || iz < 0 || iz >= dims.CountZ)
            {
                break;
            }
        }

        var count = 0;
        foreach (var triangle in candidates)
        {
            if (IntersectsRay(point, direction, triangle.A, triangle.B, triangle.C))
            {
                count++;
            }
        }
        return count % 2 == 1;
    }

    // Moller-Trumbore ray-triangle intersection, no backface culling -
    // only whether a forward hit exists is needed, not the hit point.
    private static bool IntersectsRay(Vector3 origin, Vector3 direction, Vector3 a, Vector3 b, Vector3 c)
    {
        const float epsilon = 1e-8f;
        var edge1 = b - a;
        var edge2 = c - a;
        var pVec = Vector3.Cross(direction, edge2);
        var det = Vector3.Dot(edge1, pVec);
        if (Math.Abs(det) < epsilon)
        {
            return false;
        }
        var invDet = 1.0f / det;
        var tVec = origin - a;
        var u = Vector3.Dot(tVec, pVec) * invDet;
        if (u < 0 || u > 1)
        {
            return false;
        }
        var qVec = Vector3.Cross(tVec, edge1);
        var v = Vector3.Dot(direction, qVec) * invDet;
        if (v < 0 || u + v > 1)
        {
            return false;
        }
        var t = Vector3.Dot(edge2, qVec) * invDet;
        return t > epsilon;
    }

    private static bool IsCubeIncluded(
        int ix, int iy, int iz, Vector3 center, float half, Vector3 boxMin, float cellSize, GridDims dims,
        Dictionary<(int, int, int), List<Triangle>> grid)
    {
        if (grid.TryGetValue((ix, iy, iz), out var bucket))
        {
            foreach (var triangle in bucket)
            {
                if (TriangleIntersectsBox(triangle, center, half))
                {
                    return true;
                }
            }
        }
        // No triangle touches the cube at all - it's either fully inside or
        // fully outside the body. One point suffices to tell which.
        return IsPointInsideViaGrid(center, boxMin, cellSize, dims, grid);
    }
}