namespace Solvix.MeshBuilder;

// MeshBuilder's own boundary error, same reasoning as MeshTooLargeException
// - Solvix.Api catches this, never Solvix.Voxelization.MalformedMeshException
// directly (see MeshBuilderFacade, which is the only place that translates
// one into the other).
public sealed class InvalidMeshException(string message) : Exception(message);