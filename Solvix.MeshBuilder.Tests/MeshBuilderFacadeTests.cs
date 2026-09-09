using Solvix.Voxelization;

namespace Solvix.MeshBuilder.Tests;

// A controllable stand-in for the real Voxelizer - lets these tests assert
// on MeshBuilderFacade's OWN logic (delegation, exception translation) in
// isolation, rather than needing to drive the real SAT/ray-parity algorithm
// just to observe how the facade behaves around it.
public sealed class FakeVoxelizer : IVoxelizer
{
    public byte[]? ReturnValue { get; set; }
    public Exception? ThrowOnVoxelize { get; set; }
    public byte[]? ReceivedMeshBinary { get; private set; }
    public CancellationToken ReceivedCancellationToken { get; private set; }

    public byte[] Voxelize(byte[] meshBinary, CancellationToken cancellationToken = default)
    {
        ReceivedMeshBinary = meshBinary;
        ReceivedCancellationToken = cancellationToken;
        if (ThrowOnVoxelize is not null)
        {
            throw ThrowOnVoxelize;
        }
        return ReturnValue ?? [];
    }
}

public class MeshBuilderFacadeTests
{
    private FakeVoxelizer _voxelizer = null!;
    private MeshBuilderFacade _facade = null!;

    [SetUp]
    public void SetUp()
    {
        _voxelizer = new FakeVoxelizer();
        _facade = new MeshBuilderFacade(_voxelizer);
    }

    [Test]
    public void Delegates_the_mesh_bytes_and_cancellation_token_to_the_voxelizer_unchanged()
    {
        var input = new byte[] { 1, 2, 3 };
        using var cts = new CancellationTokenSource();
        _voxelizer.ReturnValue = [4, 5, 6];

        var response = _facade.Voxelize(input, cts.Token);

        Assert.That(_voxelizer.ReceivedMeshBinary, Is.SameAs(input));
        Assert.That(_voxelizer.ReceivedCancellationToken, Is.EqualTo(cts.Token));
        Assert.That(response, Is.SameAs(_voxelizer.ReturnValue));
    }

    // The one thing that's actually MeshBuilderFacade's own logic (not
    // just delegation) - translating Solvix.Voxelization's exceptions into
    // MeshBuilder's own, so Solvix.Api never needs to know
    // Solvix.Voxelization exists, even to catch its exception types.
    [Test]
    public void Translates_the_voxelization_too_large_exception_into_its_own_type_with_the_same_counts()
    {
        _voxelizer.ThrowOnVoxelize = new VoxelizationTooLargeException(5000, 1000);

        var thrown = Assert.Throws<MeshTooLargeException>(() => _facade.Voxelize([], CancellationToken.None));
        Assert.That(thrown.CellCount, Is.EqualTo(5000));
        Assert.That(thrown.Limit, Is.EqualTo(1000));
    }

    [Test]
    public void Translates_the_malformed_mesh_exception_into_its_own_type_with_the_same_message()
    {
        _voxelizer.ThrowOnVoxelize = new MalformedMeshException("bad mesh");

        var thrown = Assert.Throws<InvalidMeshException>(() => _facade.Voxelize([], CancellationToken.None));
        Assert.That(thrown.Message, Is.EqualTo("bad mesh"));
    }

    [Test]
    public void Lets_any_other_exception_propagate_untranslated()
    {
        _voxelizer.ThrowOnVoxelize = new InvalidOperationException("unrelated failure");

        Assert.Throws<InvalidOperationException>(() => _facade.Voxelize([], CancellationToken.None));
    }
}