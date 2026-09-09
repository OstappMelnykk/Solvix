namespace Solvix.Voxelization;

// Public - like VoxelizationTooLargeException, this needs to cross out of
// this project so Solvix.MeshBuilder's facade can translate it into a
// clean HTTP 400 instead of a malformed/adversarial request body surfacing
// as an unhandled 500 (a huge allocation attempt, IndexOutOfRangeException,
// etc. - see MeshBinarySerializer, the only thrower).
public sealed class MalformedMeshException(string message) : Exception(message);