namespace Solvix.Mesh;

/// <summary>Face of a hex, named by the local axis it is normal to and the side it lies on.</summary>
public enum HexFace
{
    XMinus = 0, XPlus = 1,
    YMinus = 2, YPlus = 3,
    ZMinus = 4, ZPlus = 5,
}

public static class HexFaces
{
    public static readonly HexFace[] All = Enum.GetValues<HexFace>();

    public static int Axis(this HexFace face) => (int)face / 2;

    public static int Sign(this HexFace face) => (int)face % 2 == 0 ? -1 : +1;

    public static HexFace Opposite(this HexFace face) => (HexFace)((int)face ^ 1);

    /// <summary>Lattice offset from a cell to the cell across this face.</summary>
    public static (int I, int J, int K) Offset(this HexFace face)
    {
        int s = face.Sign();
        return face.Axis() switch { 0 => (s, 0, 0), 1 => (0, s, 0), _ => (0, 0, s) };
    }

    /// <summary>The 8 slots (4 corners + 4 edge midpoints) lying on the face.</summary>
    public static IReadOnlyList<int> Slots(this HexFace face) => FaceSlots[(int)face];

    /// <summary>
    /// The slot on the opposite face of the neighbouring hex that coincides with
    /// <paramref name="slot"/> across this face (same coordinates on the two other
    /// axes), or -1 when the slot is not on this face. Neighbouring hexes always
    /// share axis orientation, so this pairing is purely topological.
    /// </summary>
    public static int PartnerSlot(this HexFace face, int slot) => PartnerTable[(int)face, slot];

    /// <summary>The two axes lying in the face's plane, in ascending order.</summary>
    public static (int T1, int T2) Tangents(this HexFace face) => face.Axis() switch { 0 => (1, 2), 1 => (0, 2), _ => (0, 1) };

    /// <summary>
    /// Position of a face slot on the face's own square, (u, v) in {-1,0,1}^2
    /// (never the centre): the local coordinates along the two tangent axes.
    /// </summary>
    public static (int U, int V) Uv(this HexFace face, int slot)
    {
        var (t1, t2) = face.Tangents();
        return (Hex20Reference.LocalCoords[slot, t1], Hex20Reference.LocalCoords[slot, t2]);
    }

    /// <summary>The slot at (u, v) on the face, or -1 for the centre (which carries no node).</summary>
    public static int SlotAt(this HexFace face, int u, int v)
    {
        foreach (int slot in face.Slots())
        {
            if (face.Uv(slot) == (u, v)) return slot;
        }
        return -1;
    }

    /// <summary>
    /// The slot on <paramref name="other"/> that glues to <paramref name="slot"/> of
    /// this face when the two faces are joined with orientation
    /// <paramref name="orientation"/> (see <see cref="FaceOrientation"/>), or -1 when
    /// the slot is not on this face.
    /// </summary>
    public static int Partner(this HexFace face, HexFace other, int orientation, int slot)
    {
        if (Hex20Reference.LocalCoords[slot, face.Axis()] != face.Sign()) return -1;
        var (u, v) = face.Uv(slot);
        var (u2, v2) = FaceOrientation.Apply(orientation, u, v);
        return other.SlotAt(u2, v2);
    }

    private static readonly int[][] FaceSlots = BuildFaceSlots();
    private static readonly int[,] PartnerTable = BuildPartners();

    private static int[][] BuildFaceSlots() =>
        All.Select(face => Enumerable.Range(0, Hex20Reference.NodeCount)
            .Where(s => Hex20Reference.LocalCoords[s, face.Axis()] == face.Sign())
            .ToArray()).ToArray();

    private static int[,] BuildPartners()
    {
        var table = new int[6, Hex20Reference.NodeCount];
        foreach (var face in All)
        {
            int axis = face.Axis();
            for (int s = 0; s < Hex20Reference.NodeCount; s++)
            {
                table[(int)face, s] = -1;
                if (Hex20Reference.LocalCoords[s, axis] != face.Sign()) continue;
                for (int t = 0; t < Hex20Reference.NodeCount; t++)
                {
                    if (Hex20Reference.LocalCoords[t, axis] != -face.Sign()) continue;
                    bool same = true;
                    for (int d = 0; d < 3; d++)
                        if (d != axis && Hex20Reference.LocalCoords[s, d] != Hex20Reference.LocalCoords[t, d]) same = false;
                    if (same) table[(int)face, s] = t;
                }
            }
        }
        return table;
    }
}

/// <summary>
/// How the squares of two glued faces line up: one of the 8 symmetries of the
/// square (swap the two face axes or not, flip each axis or not), encoded as
/// <c>(swap ? 4 : 0) | (flipU ? 2 : 0) | (flipV ? 1 : 0)</c>. Two faces of
/// lattice-adjacent hexes (opposite faces) glue with orientation 0.
/// </summary>
public static class FaceOrientation
{
    public const int Identity = 0;
    public const int Count = 8;

    public static (int U, int V) Apply(int orientation, int u, int v)
    {
        if ((orientation & 4) != 0) (u, v) = (v, u);
        if ((orientation & 2) != 0) u = -u;
        if ((orientation & 1) != 0) v = -v;
        return (u, v);
    }

    /// <summary>The orientation that undoes <paramref name="orientation"/>.</summary>
    public static int Inverse(int orientation)
    {
        for (int h = 0; h < Count; h++)
        {
            if (Apply(h, Apply(orientation, 1, 0).U, Apply(orientation, 1, 0).V) == (1, 0)
                && Apply(h, Apply(orientation, 0, 1).U, Apply(orientation, 0, 1).V) == (0, 1))
                return h;
        }
        throw new InvalidOperationException("Every orientation has an inverse.");
    }
}
