using System.Numerics;

namespace Solvix.Voxelization;

internal readonly record struct Triangle(Vector3 A, Vector3 B, Vector3 C);

internal readonly record struct GridDims(int CountX, int CountY, int CountZ);