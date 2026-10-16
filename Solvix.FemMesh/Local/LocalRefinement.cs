using System.Numerics;
using Solvix.Contracts.Facades;

namespace Solvix.FemMesh.Local;

/// <summary>
/// The local rule: parts of the body are cut finer, and the cells round them are cut by transition templates (T1, T2, T4) so that no node of a finer
/// cell hangs on the face of a coarser one - the mesh stays conforming. The result is the same kind of thing the even rule gives: a mesh of
/// 20-node elements (<see cref="IFemMesh"/>), each placed in its cube by its centre; the solver cannot tell the two apart.
/// <para>
/// The cubes of the editor are the cells of a lattice (their (I, J, K)); the refinement runs on the integer lattice, where every node is exact, and the real
/// position of anything is its place in its cube pushed through the cube's 20-node map - so a cube that is moved drags its children with it, and the
/// nodes on a face that two linked cubes share are the same node (cubes that only stand side by side keep nodes of their own).
/// </para>
/// </summary>
public sealed class LocalRefinement(IReadOnlyList<RefinementStep> history) : IMeshRefinement
{
    public string Name => $"local ({history.Count} steps)";

    public IReadOnlyList<RefinementStep> History { get; } = history;

    /// <summary>The key of the leaf of the coarse mesh that is the whole cube with this editor id: what a first refinement names a cube by.</summary>
    public static string RootKey(int hexId) => $"{hexId}|1|0,0,0;1,0,0;0,1,0;1,1,0;0,0,1;1,0,1;0,1,1;1,1,1";

    /// <summary>
    /// The key of a leaf: the editor id of its cube (<paramref name="hexIds"/> is the id of each root of the lattice) and the place of its eight corners inside the cube as exact fractions,
    /// in lowest terms. It does not change when the lattice gets finer, nor when other cubes come and go.
    /// </summary>
    public static string LeafKey(LatticeMesh mesh, Cell cell, IReadOnlyList<int> hexIds)
    {
        var root = mesh.Roots[cell.Root];
        long scale = mesh.Scale;
        var numbers = new long[24];
        for (int s = 0; s < 8; s++)
        {
            var p = mesh.PointOf(cell.Nodes[s]);
            numbers[3 * s] = p.X - root.I * scale;
            numbers[3 * s + 1] = p.Y - root.J * scale;
            numbers[3 * s + 2] = p.Z - root.K * scale;
        }
        long gcd = scale;
        foreach (long n in numbers) gcd = (long)BigInteger.GreatestCommonDivisor(gcd, Math.Abs(n));
        var corners = Enumerable.Range(0, 8).Select(s => $"{numbers[3 * s] / gcd},{numbers[3 * s + 1] / gcd},{numbers[3 * s + 2] / gcd}");
        return $"{hexIds[cell.Root]}|{scale / gcd}|{string.Join(';', corners)}";
    }

    /// <summary>The coarse mesh with the history replayed on it: the lattice of the leaves.</summary>
    public LatticeMesh Replay(FemMeshDto coarse)
    {
        if (coarse.Cells is null || coarse.Cells.Count != 3 * coarse.ElementCount)
            throw new InvalidOperationException("Local refinement needs the cell (I, J, K) of every cube; the coarse mesh does not say where its cubes are.");
        var cells = Enumerable.Range(0, coarse.ElementCount).Select(e => (coarse.Cells[3 * e], coarse.Cells[3 * e + 1], coarse.Cells[3 * e + 2])).ToList();
        var mesh = LatticeMesh.FromCells(cells);
        foreach (var step in history)
        {
            var wanted = step.Leaves.ToHashSet();
            var marked = mesh.Cells.Values.Where(c => wanted.Contains(LeafKey(mesh, c, coarse.ElementIds))).Select(c => c.Id).ToList();
            if (marked.Count == 0) continue;                              // everything the step named is gone
            Refiner.Refine(mesh, marked, step.NI, step.NJ, step.NK, step.TransitionDepth);
        }
        return mesh;
    }

    public IFemMesh Build(FemMeshDto coarse)
    {
        var lattice = Replay(coarse);
        return LatticeToFem.Convert(lattice, coarse);
    }
}
