using System.Numerics;

namespace Solvix.Voxelization;

// Orchestrates turning a triangle mesh into a set of unit voxels: collects
// triangles, computes the bounding box and grid dimensions, builds a
// TriangleSpatialGrid to accelerate lookups, then for each cell decides
// inclusion via a SAT triangle-vs-box test (cells the surface actually
// touches) or a grid-accelerated ray-parity test (cells fully enclosed by
// the surface). Internal - see Voxelizer.cs for this project's sole public
// entry point.
internal sealed class VoxelizationService
{
    // The cube side is always literally 1 - density is achieved by the
    // caller scaling the mesh's vertices before calling Voxelize(), never
    // by a parameter here.
    private const float UnitCubeSize = 1.0f;

    // Hard cap on grid cells so a mesh scaled far too large relative to the
    // unit cube fails fast instead of hanging.
    private const int MaxCells = 900_000;

    // Rays for the inside/outside parity test - THREE, not one, voted by
    // majority (see IsPointInsideViaGrid). A single ray is a single point
    // of failure: real imported meshes are rarely perfectly watertight,
    // and even on a watertight one a ray can graze exactly along some
    // edge it happens to be near-parallel to, flipping that one cell's
    // parity count and producing an isolated "ghost" cube with no
    // connection to the actual body - triangulated rectangular faces
    // (near-universal in architectural/CAD imports) are exactly this: two
    // triangles sharing a diagonal edge, which a ray passing close to that
    // diagonal can register as crossing TWICE (once per triangle) instead
    // of once. Varying only the DIRECTION isn't enough on its own - all
    // three still fire from the exact same query point, so if that point
    // is the thing that's unluckily positioned relative to some diagonal,
    // every direction from it inherits the same risk. Each vote also
    // starts from a slightly different ORIGIN (a small fixed offset, a
    // fraction of one cell) so the three votes aren't all staring at the
    // same potentially-degenerate feature from the same spot.
    private static readonly (Vector3 Direction, Vector3 OriginJitter)[] InsideTestRays =
    [
        (Vector3.Normalize(new Vector3(0.9137f, 0.2711f, 0.3053f)), new Vector3(0.017f, -0.023f, 0.011f)),
        (Vector3.Normalize(new Vector3(0.2416f, 0.8837f, -0.3981f)), new Vector3(-0.013f, 0.019f, -0.029f)),
        (Vector3.Normalize(new Vector3(-0.5271f, 0.3162f, 0.7889f)), new Vector3(0.021f, 0.007f, -0.017f))
    ];

    public VoxelizationResult Voxelize(ImportedSurfaceMesh mesh, CancellationToken cancellationToken = default)
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
        var countX = SafeCellCount(boxMax.X - boxMin.X, cellSize);
        var countY = SafeCellCount(boxMax.Y - boxMin.Y, cellSize);
        var countZ = SafeCellCount(boxMax.Z - boxMin.Z, cellSize);
        // long, not int - countX*countY*countZ can individually be capped
        // to at most MaxCells+1 by SafeCellCount, but their PRODUCT still
        // overflows int32 well before any one axis alone gets that large
        // (e.g. 50_000 x 50_000 x 1 already exceeds int.MaxValue). Doing
        // this multiply in int let an attacker-scaled mesh wrap the count
        // to a small/negative number and slip past the MaxCells check
        // below entirely.
        var estimatedCellsLong = (long)countX * countY * countZ;
        if (estimatedCellsLong > MaxCells)
        {
            throw new VoxelizationTooLargeException((int)Math.Min(estimatedCellsLong, int.MaxValue), MaxCells);
        }
        var estimatedCells = (int)estimatedCellsLong; // safe: <= MaxCells (900_000) here

        var dims = new GridDims(countX, countY, countZ);
        var grid = TriangleSpatialGrid.Build(triangles, boxMin, cellSize, dims);

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
            // Checked once per X-slice, not per cell - cheap enough not to
            // matter even at MaxCells, but still catches a cancelled
            // request (client disconnected, see MeshesController) well
            // before a large grid finishes computing for nobody.
            cancellationToken.ThrowIfCancellationRequested();
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

    // Ceiling(span / cellSize), clamped to a value that's always safe to
    // multiply against the other two axes in an int (see estimatedCellsLong
    // in Voxelize) - a malformed/attacker-scaled mesh's bounding box can
    // make the raw ratio NaN, infinite, or simply too large for `(int)` to
    // cast correctly (an out-of-range double->int cast in C# is
    // unchecked and produces an unspecified result, not an exception).
    // Capping at MaxCells+1 is enough: Voxelize's own combined check
    // throws VoxelizationTooLargeException as soon as any axis (or their
    // product) exceeds MaxCells, so the exact oversized value never
    // matters past this point.
    private static int SafeCellCount(float span, float cellSize)
    {
        var raw = Math.Ceiling(span / cellSize);
        if (double.IsNaN(raw) || raw > MaxCells)
        {
            return MaxCells + 1;
        }
        return Math.Max(1, (int)raw);
    }

    // Separating-axis test (Akenine-Moller) for triangle vs axis-aligned
    // box - needed on top of the inside test because a cube whose CENTER is
    // outside the body can still have the surface cut through one of its
    // corners/edges. `isBoundaryExactOnly` (only meaningful when this
    // returns true) flags a specific degenerate case, checked on ALL 13
    // axes (the 3 box axes, the 9 edge-cross axes, AND the triangle's own
    // normal - not just the box axes, since the voxel grid is always
    // WORLD-axis-aligned and never rotates with the mesh: an unrotated
    // architectural mesh hits this on the 3 box axes specifically
    // (axis-aligned rectangular faces landing exactly on grid lines), but
    // a mesh rotated to some other angle can hit the exact same
    // coincidence on one of the other 10 axes instead, once some edge or
    // face-normal direction happens to line up with the box just as
    // exactly). The triangle projects to a single flat value along an
    // axis (inevitable for its own normal, common for edges) AND that
    // value lands EXACTLY on this box's boundary along that axis - a
    // coincidence any of these axes can hit once the mesh's own
    // dimensions/orientation are round numbers relative to the 1-unit
    // grid. That configuration registers as "touching" on BOTH sides of
    // the boundary: the box whose solid interior the face actually
    // bounds, AND the neighboring box on the empty far side of it, which
    // the mesh's solid never occupies at all. IsCubeIncluded uses this
    // flag to avoid trusting such a touch on its own (see there for why
    // NOT the face's normal direction, which would be the obvious fix but
    // isn't safe: real imported meshes can't be trusted to have
    // consistent outward winding).
    private static bool TriangleIntersectsBox(Triangle triangle, Vector3 boxCenter, float boxHalf, out bool isBoundaryExactOnly)
    {
        var v0 = triangle.A - boxCenter;
        var v1 = triangle.B - boxCenter;
        var v2 = triangle.C - boxCenter;
        var boundaryExact = false;

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
            const float epsilon = 1e-4f;
            if (triMax - triMin < epsilon * MathF.Max(1f, r) && (Math.Abs(triMin - r) < epsilon * MathF.Max(1f, r) || Math.Abs(triMax + r) < epsilon * MathF.Max(1f, r)))
            {
                boundaryExact = true;
            }
            return triMin <= r && triMax >= -r;
        }

        Vector3[] boxAxes = [new(1, 0, 0), new(0, 1, 0), new(0, 0, 1)];
        foreach (var axis in boxAxes)
        {
            if (!OverlapsOnAxis(axis))
            {
                isBoundaryExactOnly = false;
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
                    isBoundaryExactOnly = false;
                    return false;
                }
            }
        }

        var triangleNormal = Vector3.Cross(edges[0], edges[1]);
        if (!OverlapsOnAxis(triangleNormal))
        {
            isBoundaryExactOnly = false;
            return false;
        }

        isBoundaryExactOnly = boundaryExact;
        return true;
    }

    // Majority vote across InsideTestRays - see that field's comment for
    // why neither the direction nor the origin alone is trusted outright.
    private static bool IsPointInsideViaGrid(Vector3 point, Vector3 boxMin, float cellSize, GridDims dims, TriangleSpatialGrid grid)
    {
        var insideVotes = 0;
        foreach (var (direction, originJitter) in InsideTestRays)
        {
            var origin = point + originJitter * cellSize;
            if (IsPointInsideAlongRay(origin, direction, boxMin, cellSize, dims, grid))
            {
                insideVotes++;
            }
        }
        return insideVotes * 2 > InsideTestRays.Length;
    }

    // Parity ray-cast test: a point is inside a closed surface iff a ray
    // from it crosses the surface an odd number of times. Walks the same
    // uniform grid via 3D DDA (Amanatides-Woo) so only triangles in cells
    // the ray actually passes through get tested.
    private static bool IsPointInsideAlongRay(Vector3 point, Vector3 direction, Vector3 boxMin, float cellSize, GridDims dims, TriangleSpatialGrid grid)
    {
        var ix = grid.CellIndexX(point.X);
        var iy = grid.CellIndexY(point.Y);
        var iz = grid.CellIndexZ(point.Z);

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
            foreach (var triangle in grid.TrianglesNear(ix, iy, iz))
            {
                candidates.Add(triangle);
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
        int ix, int iy, int iz, Vector3 center, float half, Vector3 boxMin, float cellSize, GridDims dims, TriangleSpatialGrid grid)
    {
        foreach (var triangle in grid.TrianglesNear(ix, iy, iz))
        {
            if (TriangleIntersectsBox(triangle, center, half, out var isBoundaryExactOnly) && !isBoundaryExactOnly)
            {
                return true; // a genuine, non-degenerate touch - trust it immediately
            }
        }
        // No triangle touches the cube at all, or every touch found was a
        // boundary-exact coincidence (see TriangleIntersectsBox) - neither
        // is trustworthy evidence of solid volume on its own, so the
        // ray-parity test (independent of face winding, unlike a
        // normal-direction tiebreak would be) makes the actual call.
        return IsPointInsideViaGrid(center, boxMin, cellSize, dims, grid);
    }
}