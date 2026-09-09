namespace Solvix.Voxelization.Tests;

// Exercises Voxelizer as its actual callers (Solvix.MeshBuilder) see it -
// raw bytes in, raw bytes out - as opposed to VoxelizationServiceTests/
// MeshBinarySerializerTests/VoxelizationResultBinarySerializerTests, which
// use InternalsVisibleTo to test the pieces Voxelizer wires together in
// isolation.
public class VoxelizerTests
{
    // The same box mesh shape as VoxelizationServiceTests.Box(2*half, ...),
    // encoded as MeshBinarySerializer's wire format directly (no vertex
    // welding - matches solvix-web/src/app/geometry/mesh-contract.ts).
    // `half` parameterizes the box's size so the same encoder can produce
    // both a normal unit box and one scaled far too large.
    private static byte[] EncodeBox(float half = 0.5f)
    {
        var h = half;
        float[] vertices =
        [
            -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
            -h, -h, h, h, -h, h, h, h, h, -h, h, h
        ];
        uint[] indices =
        [
            0, 1, 2, 0, 2, 3,
            5, 4, 7, 5, 7, 6,
            4, 0, 3, 4, 3, 7,
            1, 5, 6, 1, 6, 2,
            3, 2, 6, 3, 6, 7,
            4, 5, 1, 4, 1, 0
        ];

        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        writer.Write((uint)(vertices.Length / 3));
        writer.Write((uint)indices.Length);
        foreach (var component in vertices)
        {
            writer.Write(component);
        }
        foreach (var index in indices)
        {
            writer.Write(index);
        }
        return stream.ToArray();
    }

    [Test]
    public void Voxelizes_a_unit_box_end_to_end_through_the_public_byte_interface()
    {
        var response = new Voxelizer().Voxelize(EncodeBox());

        using var reader = new BinaryReader(new MemoryStream(response));
        Assert.That(reader.ReadSingle(), Is.EqualTo(-0.5f)); // origin.x
        Assert.That(reader.ReadSingle(), Is.EqualTo(-0.5f)); // origin.y
        Assert.That(reader.ReadSingle(), Is.EqualTo(-0.5f)); // origin.z
        Assert.That(reader.ReadSingle(), Is.EqualTo(1f)); // cellSize
        Assert.That(reader.ReadUInt32(), Is.EqualTo(1u)); // countX
        Assert.That(reader.ReadUInt32(), Is.EqualTo(1u)); // countY
        Assert.That(reader.ReadUInt32(), Is.EqualTo(1u)); // countZ
        Assert.That(reader.ReadByte(), Is.EqualTo(0b0000_0001)); // the one cell, occupied
        Assert.That(reader.BaseStream.Position, Is.EqualTo(reader.BaseStream.Length));
    }

    [Test]
    public void Throws_the_public_exception_type_when_the_mesh_is_scaled_too_large()
    {
        Assert.Throws<VoxelizationTooLargeException>(() => new Voxelizer().Voxelize(EncodeBox(0.5f * 200)));
    }
}