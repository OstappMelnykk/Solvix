namespace Solvix.Voxelization.Tests;

public class MeshBinarySerializerTests
{
    // Builds the exact byte layout solvix-web/src/app/geometry/mesh-contract.ts's
    // toMeshBinary produces, so this test exercises the reading side against
    // the real wire format rather than round-tripping through some other
    // writer this project doesn't ship.
    private static MemoryStream Encode(float[] vertices, uint[] indices)
    {
        var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
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
        stream.Position = 0;
        return stream;
    }

    [Test]
    public void Reads_an_empty_header_only_buffer_as_a_mesh_with_no_vertices_or_indices()
    {
        using var stream = Encode([], []);

        var mesh = MeshBinarySerializer.Deserialize(stream);

        Assert.That(mesh.Vertices, Is.Empty);
        Assert.That(mesh.Indices, Is.Empty);
    }

    [Test]
    public void Reads_vertices_and_indices_in_wire_order()
    {
        float[] vertices = [1, 2, 3, 4, 5, 6];
        uint[] indices = [0, 1];
        using var stream = Encode(vertices, indices);

        var mesh = MeshBinarySerializer.Deserialize(stream);

        Assert.That(mesh.Vertices, Is.EqualTo(new[] { new System.Numerics.Vector3(1, 2, 3), new System.Numerics.Vector3(4, 5, 6) }));
        Assert.That(mesh.Indices, Is.EqualTo(new[] { 0, 1 }));
    }

    // Regression: a body whose header LIES about how much data follows -
    // this must be caught before Deserialize sizes any allocation off the
    // declared counts, not after (see MalformedMeshException's own doc
    // comment - the whole point is catching this before `new
    // Vector3[vertexCount]` runs at all).
    [Test]
    public void Throws_MalformedMeshException_when_the_declared_counts_dont_fit_the_actual_body()
    {
        var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true))
        {
            writer.Write(0xFFFFFFFFu); // vertexCount - would need ~48GB, actual body has none of it
            writer.Write(0u);
        }
        stream.Position = 0;

        Assert.Throws<MalformedMeshException>(() => MeshBinarySerializer.Deserialize(stream));
    }

    [Test]
    public void Throws_MalformedMeshException_for_a_body_too_short_to_even_hold_the_header()
    {
        using var stream = new MemoryStream([1, 2, 3]);

        Assert.Throws<MalformedMeshException>(() => MeshBinarySerializer.Deserialize(stream));
    }

    [Test]
    public void Throws_MalformedMeshException_when_an_index_does_not_reference_a_declared_vertex()
    {
        float[] vertices = [1, 2, 3]; // one vertex (index 0 valid, 1+ invalid)
        uint[] indices = [0, 1, 2];
        using var stream = Encode(vertices, indices);

        Assert.Throws<MalformedMeshException>(() => MeshBinarySerializer.Deserialize(stream));
    }
}