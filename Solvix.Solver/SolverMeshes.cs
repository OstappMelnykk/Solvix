using Solvix.Contracts.Facades;
using Solvix.FemMesh;

namespace Solvix.Solver;

/// <summary>The mesh of finite elements the solver works on, and - when the body is cut evenly - the uniform addressing over it that the cube-by-cube view still draws from.</summary>
internal sealed record BuiltMesh(IFemMesh Mesh, FineMesh? Uniform);

internal static class SolverMeshes
{
    /// <summary>Makes the mesh the setup's rule asks for from the cubes of the editor.</summary>
    public static BuiltMesh Build(SolverSetup setup, FemMeshDto coarse)
    {
        var rule = setup.Rule();
        var mesh = rule.Build(coarse);
        return new BuiltMesh(mesh, rule is UniformRefinement uniform ? FineMesh.Of(mesh, coarse, uniform.Nx, uniform.Ny, uniform.Nz) : null);
    }
}
