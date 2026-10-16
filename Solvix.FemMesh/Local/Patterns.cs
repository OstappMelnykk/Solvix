namespace Solvix.FemMesh.Local;

/// <summary>
/// The marks on the eight nodes of a cell, as a bit mask over the slots, and what a template can do with them. A template cuts exactly the edges that
/// have one marked end, so these patterns - and only these - have a template (T3, three marks in an L, is not used):
/// none, one corner (T1), one edge (T2), one face (T4), all eight (the cell stays whole).
/// </summary>
public static class Patterns
{
    public enum Kind { None, Corner, Edge, Face, All, Invalid }

    private static readonly Kind[] Kinds = Enumerable.Range(0, 256).Select(Classify).ToArray();
    private static readonly int[] Closures = Enumerable.Range(0, 256).Select(Close).ToArray();

    public static Kind KindOf(int mask) => Kinds[mask];

    /// <summary>The smallest pattern with a template that contains the marks: the face that holds them all, or else the whole cell.</summary>
    public static int Closure(int mask) => Closures[mask];

    public static int MaskOf(IEnumerable<int> slots) => slots.Aggregate(0, (m, s) => m | 1 << s);

    private static Kind Classify(int mask)
    {
        int count = System.Numerics.BitOperations.PopCount((uint)mask);
        if (count == 0) return Kind.None;
        if (count == 1) return Kind.Corner;
        if (count == 8) return Kind.All;
        if (count == 2)
        {
            var slots = SlotsOf(mask);
            int diff = slots[0] ^ slots[1];
            return diff is 1 or 2 or 4 ? Kind.Edge : Kind.Invalid;
        }
        if (count == 4)
            for (int axis = 0; axis < 3; axis++)
                for (int side = 0; side < 2; side++)
                    if (mask == Hex.FaceMask(axis, side)) return Kind.Face;
        return Kind.Invalid;
    }

    private static int Close(int mask)
    {
        if (Classify(mask) != Kind.Invalid) return mask;
        for (int axis = 0; axis < 3; axis++)
            for (int side = 0; side < 2; side++)
            {
                int face = Hex.FaceMask(axis, side);
                if ((mask & ~face) == 0) return face;
            }
        return 255;
    }

    public static List<int> SlotsOf(int mask) => Enumerable.Range(0, 8).Where(s => (mask >> s & 1) == 1).ToList();

    /// <summary>For a pattern of kind Edge: the axis the edge runs along and the slot of its end on the minus side of that axis.</summary>
    public static (int Axis, int Start) EdgeOf(int mask)
    {
        var slots = SlotsOf(mask);
        int axis = (slots[0] ^ slots[1]) switch { 1 => 0, 2 => 1, _ => 2 };
        return (axis, slots[0]);                                           // the smaller slot has the 0 bit on that axis
    }

    /// <summary>For a pattern of kind Face: the axis it is perpendicular to and the side.</summary>
    public static (int Axis, int Side) FaceOf(int mask)
    {
        for (int axis = 0; axis < 3; axis++)
            for (int side = 0; side < 2; side++)
                if (mask == Hex.FaceMask(axis, side)) return (axis, side);
        throw new ArgumentException("Not a face.");
    }
}
