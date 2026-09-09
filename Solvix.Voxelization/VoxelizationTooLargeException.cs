namespace Solvix.Voxelization;

// Public - the one error case that needs to cross out of this project, so
// Solvix.MeshBuilder's facade (and, transitively, Solvix.Api's controller)
// can translate it into an HTTP 400 with the cell count/limit. See
// Voxelizer.cs for why everything else here is internal.
public sealed class VoxelizationTooLargeException(int cellCount, int limit)
    : Exception($"Voxelization grid too large ({cellCount} cells, limit {limit}) - the mesh is scaled too large relative to the unit cube.")
{
    public int CellCount { get; } = cellCount;
    public int Limit { get; } = limit;
}