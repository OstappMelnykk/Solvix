using Solvix.Voxelization;

namespace Solvix.MeshBuilder.Tests;

public class MeshBuilderFacadeTests
{
    private MeshBuilderFacade _facade = null!;

    [SetUp]
    public void SetUp()
    {
        _facade = new MeshBuilderFacade(new Voxelizer());
    }

    // Same 1x1x1 box mesh as Solvix.Voxelization.Tests.VoxelizerTests,
    // encoded as the wire format Voxelizer expects.
    private static byte[] EncodeUnitBox()
    {
        float h = 0.5f;
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
    public void Delegates_to_the_voxelizer_and_returns_its_bytes_unchanged()
    {
        var input = EncodeUnitBox();

        var response = _facade.Voxelize(input);

        Assert.That(response, Is.EqualTo(new Voxelizer().Voxelize(input)));
    }

    // The one thing that's actually MeshBuilderFacade's own logic (not
    // just delegation) - translating Solvix.Voxelization's exception into
    // MeshBuilder's own, so Solvix.Api never needs to know
    // Solvix.Voxelization exists, even to catch its exception type.
    [Test]
    public void Translates_the_voxelization_too_large_exception_into_its_own_type_with_the_same_counts()
    {
        float h = 0.5f * 200; // scaled far too large relative to the unit cube
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
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            writer.Write((uint)(vertices.Length / 3));
            writer.Write((uint)indices.Length);
            foreach (var component in vertices) writer.Write(component);
            foreach (var index in indices) writer.Write(index);
        }

        VoxelizationTooLargeException fromVoxelizer = null!;
        try
        {
            new Voxelizer().Voxelize(stream.ToArray());
        }
        catch (VoxelizationTooLargeException error)
        {
            fromVoxelizer = error;
        }
        Assert.That(fromVoxelizer, Is.Not.Null, "expected Voxelizer itself to throw first, to compare counts against");

        var thrown = Assert.Throws<MeshTooLargeException>(() => _facade.Voxelize(stream.ToArray()));
        Assert.That(thrown.CellCount, Is.EqualTo(fromVoxelizer.CellCount));
        Assert.That(thrown.Limit, Is.EqualTo(fromVoxelizer.Limit));
    }
}