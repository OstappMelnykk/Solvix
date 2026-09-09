namespace Solvix.MeshBuilder;

// MeshBuilder's own boundary error - Solvix.Api catches this, never
// Solvix.Voxelization.VoxelizationTooLargeException directly (see
// MeshBuilderFacade, which is the only place that translates one into the
// other). Voxelization is entirely MeshBuilder's internal concern; nothing
// upstream should need to know it exists.
public sealed class MeshTooLargeException(int cellCount, int limit)
    : Exception($"Mesh too large to voxelize ({cellCount} cells, limit {limit}).")
{
    public int CellCount { get; } = cellCount;
    public int Limit { get; } = limit;
}