using System.Numerics;

namespace Solvix.Voxelization.Tests;

public class VoxelizationResultBinarySerializerTests
{
    [Test]
    public void Writes_origin_cellSize_counts_occupancy_and_markedForRefinement_in_wire_order()
    {
        // 2x1x1 grid, cell (1,0,0) occupied -> bit index 1 -> occupancy[0] = 0b0000_0010.
        // Same cell also marked for refinement, same shape/bit convention.
        var result = new VoxelizationResult(new Vector3(-1, -0.5f, -0.5f), 1.0f, 2, 1, 1, [0b0000_0010], [0b0000_0010]);

        using var stream = new MemoryStream();
        VoxelizationResultBinarySerializer.Serialize(result, stream);
        stream.Position = 0;

        using var reader = new BinaryReader(stream);
        Assert.That(reader.ReadSingle(), Is.EqualTo(-1f));
        Assert.That(reader.ReadSingle(), Is.EqualTo(-0.5f));
        Assert.That(reader.ReadSingle(), Is.EqualTo(-0.5f));
        Assert.That(reader.ReadSingle(), Is.EqualTo(1f));
        Assert.That(reader.ReadUInt32(), Is.EqualTo(2u));
        Assert.That(reader.ReadUInt32(), Is.EqualTo(1u));
        Assert.That(reader.ReadUInt32(), Is.EqualTo(1u));
        Assert.That(reader.ReadByte(), Is.EqualTo(0b0000_0010));
        Assert.That(reader.ReadByte(), Is.EqualTo(0b0000_0010));
        Assert.That(stream.Position, Is.EqualTo(stream.Length));
    }

    [Test]
    public void Writes_the_full_occupancy_and_markedForRefinement_arrays_verbatim_for_a_multi_byte_grid()
    {
        byte[] occupancy = [0xFF, 0x01];
        byte[] markedForRefinement = [0x04, 0x00];
        var result = new VoxelizationResult(Vector3.Zero, 1.0f, 9, 1, 1, occupancy, markedForRefinement);

        using var stream = new MemoryStream();
        VoxelizationResultBinarySerializer.Serialize(result, stream);

        var bytes = stream.ToArray();
        // header = 3 floats (origin) + 1 float (cellSize) + 3 uints (counts) = 28 bytes.
        Assert.That(bytes.Skip(28).Take(2).ToArray(), Is.EqualTo(occupancy));
        Assert.That(bytes.Skip(30).ToArray(), Is.EqualTo(markedForRefinement));
    }
}