using System.Numerics;

namespace Solvix.Voxelization;

// Triangle soup, in world space: every 3 consecutive entries in `Indices`
// are one triangle's vertex indices into `Vertices`. Internal - this
// project's only public surface is Voxelizer (byte[] in, byte[] out) and
// VoxelizationTooLargeException, see Voxelizer.cs.
internal sealed record ImportedSurfaceMesh(IReadOnlyList<Vector3> Vertices, IReadOnlyList<int> Indices);