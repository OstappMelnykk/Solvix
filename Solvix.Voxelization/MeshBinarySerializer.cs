using System.Numerics;

namespace Solvix.Voxelization;

// Deserializes Voxelizer's input - binary instead of JSON since a real
// 2.9M-triangle STL produced a ~690MB JSON body against the endpoint's
// request-size cap; the same mesh in this layout is ~140MB (12 bytes/vertex
// + 4 bytes/index instead of ~70 bytes per JSON {"x":...,"y":...,"z":...}
// object). Mirrors solvix-web/src/app/geometry/mesh-contract.ts's
// toMeshBinary, which is the only producer of this format. Layout,
// little-endian throughout (BinaryReader's primitive reads are always
// little-endian regardless of host architecture, matching the writer
// side's explicit DataView(..., true)):
//   [uint32 vertexCount]
//   [uint32 indexCount]
//   [vertexCount * 3 float32, x,y,z interleaved]
//   [indexCount * uint32]
internal static class MeshBinarySerializer
{
    public static ImportedSurfaceMesh Deserialize(Stream stream)
    {
        using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);

        var vertexCount = reader.ReadUInt32();
        var indexCount = reader.ReadUInt32();

        var vertices = new Vector3[vertexCount];
        for (var i = 0; i < vertexCount; i++)
        {
            vertices[i] = new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
        }

        var indices = new int[indexCount];
        for (var i = 0; i < indexCount; i++)
        {
            indices[i] = checked((int)reader.ReadUInt32());
        }

        return new ImportedSurfaceMesh(vertices, indices);
    }
}