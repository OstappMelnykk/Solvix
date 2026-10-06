namespace Solvix.Mesh;

/// <summary>
/// A mesh node. <see cref="Position"/> lives in the real (deformable) world;
/// <see cref="Ideal"/> is its fixed position on the integer lattice of the
/// ideal world, in doubled units (so edge midpoints are integers too).
/// </summary>
public sealed class MeshNode
{
    public MeshNode(int id, Vec3 position, (int X, int Y, int Z) ideal)
    {
        Id = id;
        Position = position;
        Ideal = ideal;
    }

    public int Id { get; }
    public Vec3 Position { get; internal set; }
    public (int X, int Y, int Z) Ideal { get; }
}
