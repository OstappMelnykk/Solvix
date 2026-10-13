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
    public static int PartnerSlot(this HexFace face, int slot) => Partner[(int)face, slot];

    private static readonly int[][] FaceSlots = BuildFaceSlots();
    private static readonly int[,] Partner = BuildPartners();

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
