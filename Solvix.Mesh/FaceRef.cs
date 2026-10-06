namespace Solvix.Mesh;

/// <summary>Stable identity of one face of one hex: the thing the user clicks.</summary>
public readonly record struct FaceRef(int Hex, HexFace Face);

public enum FaceStatus
{
    /// <summary>Nothing sits against this face.</summary>
    Free,
    /// <summary>Linked: the two hexes are neighbours and share the face nodes.</summary>
    Linked,
    /// <summary>Another hex sits across it in the ideal lattice but is not a neighbour.</summary>
    Candidate,
}

/// <param name="Other">The face across (linked or candidate), or null when free.</param>
/// <param name="Coincident">Whether the two faces coincide in real space (null when free).</param>
/// <param name="Gap">Largest distance between corresponding nodes (null when free).</param>
/// <param name="Seam">The two faces are not opposite faces of lattice-adjacent hexes: they meet only because the nodes were moved (a "seam").</param>
public sealed record FaceState(FaceRef Face, FaceStatus Status, FaceRef? Other, bool? Coincident, double? Gap, bool Seam = false);

/// <summary>What a face is glued to: the other hex, its face, and how the squares line up (<see cref="FaceOrientation"/>).</summary>
public readonly record struct FaceLink(int Hex, HexFace Face, int Orientation);

public enum LinkFit
{
    /// <summary>Link only if the faces already coincide.</summary>
    Strict,
    /// <summary>Fit the second hex's face onto the first, then link.</summary>
    AdaptSecond,
}
