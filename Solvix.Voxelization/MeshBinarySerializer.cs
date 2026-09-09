using System.Numerics;

namespace Solvix.Voxelization;

// Deserializes Voxelizer's input - binary instead of JSON since a real
// 2.9M-triangle STL produced a ~690MB JSON body against the endpoint's
// 300MB request-size cap; the same mesh in this layout is ~140MB (12
// bytes/vertex + 4 bytes/index instead of ~70 bytes per JSON
// {"x":...,"y":...,"z":...} object). Mirrors
// solvix-web/src/app/geometry/mesh-contract.ts's toMeshBinary, which is the
// only producer of this format. Layout, little-endian throughout
// (BinaryReader's primitive reads are always little-endian regardless of
// host architecture, matching the writer side's explicit DataView(..., true)):
//   [uint32 vertexCount]
//   [uint32 indexCount]
//   [vertexCount * 3 float32, x,y,z interleaved]
//   [indexCount * uint32]
internal static class MeshBinarySerializer
{
    public static ImportedSurfaceMesh Deserialize(Stream stream)
    {
        // vertexCount/indexCount are declared by the CALLER and used to
        // size allocations before any of the actual float/int payload is
        // read - validated against the stream's real remaining length
        // FIRST, so a tiny, adversarial body (an 8-byte header claiming
        // vertexCount = 0xFFFFFFFF) can't make `new Vector3[vertexCount]`
        // attempt a multi-gigabyte allocation before anyone notices the
        // body doesn't actually contain that much data. Relies on the
        // stream being seekable (Voxelizer always hands this a
        // MemoryStream) - not a general-purpose Stream API assumption,
        // just this internal format's only actual caller.
        if (stream.Length - stream.Position < 8)
        {
            throw new MalformedMeshException("Mesh body is smaller than its own 8-byte header.");
        }

        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);

        var vertexCount = reader.ReadUInt32();
        var indexCount = reader.ReadUInt32();

        // long, not uint/int - vertexCount and indexCount are each
        // attacker-controlled uint32s, so vertexCount*12 alone can already
        // overflow a 32-bit accumulator before it's ever compared against
        // the stream's real length.
        var expectedRemainingBytes = vertexCount * 12L + indexCount * 4L;
        if (expectedRemainingBytes > stream.Length - stream.Position)
        {
            throw new MalformedMeshException(
                $"Mesh body ({stream.Length - stream.Position} bytes remaining) is smaller than its declared vertexCount ({vertexCount}) and indexCount ({indexCount}) require ({expectedRemainingBytes} bytes).");
        }

        var vertices = new Vector3[vertexCount];
        for (var i = 0; i < vertexCount; i++)
        {
            vertices[i] = new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
        }

        var indices = new int[indexCount];
        for (var i = 0; i < indexCount; i++)
        {
            var index = reader.ReadUInt32();
            // Every index must reference an actual vertex - the SAME check
            // as JS array bounds, just made explicit rather than left to
            // whatever exception VoxelizationService.CollectTriangles
            // happens to throw on Vertices[Indices[i]] once it's too late
            // to report this cleanly.
            if (index >= vertexCount)
            {
                throw new MalformedMeshException($"Index {index} at position {i} does not reference one of the {vertexCount} declared vertices.");
            }
            indices[i] = (int)index;
        }

        return new ImportedSurfaceMesh(vertices, indices);
    }
}