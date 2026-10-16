namespace Solvix.FemMesh.Local;

/// <summary>
/// One local refinement, as it is stored: which leaves (named by their <see cref="LocalRefinement.LeafKey"/>, which does not change as the mesh gets finer),
/// into how many parts along each axis, and how wide the transition zone round them is. Replaying the steps in order on the coarse mesh gives the same mesh
/// every time, so a refinement survives a change of the coarse mesh (a step that names a leaf that is no longer there is skipped for that leaf).
/// </summary>
public sealed record RefinementStep(IReadOnlyList<string> Leaves, int NI, int NJ, int NK, int TransitionDepth = 0);
