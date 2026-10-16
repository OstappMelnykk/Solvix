namespace Solvix.Solver;

/// <summary>The editor's face names and the solver's local face indices (0 bottom, 1 top, 2 front, 3 back, 4 left, 5 right).</summary>
internal static class SolverFaces
{
    // The solver's local axes are the editor's: alpha = x (left/right), beta = y (front/back), gamma = z (bottom/top).
    private static readonly Dictionary<string, int> Index = new()
    {
        ["XMinus"] = 4, ["XPlus"] = 5, ["YMinus"] = 2, ["YPlus"] = 3, ["ZMinus"] = 0, ["ZPlus"] = 1,
    };

    /// <summary>The editor's names of the sides of a cube.</summary>
    public static IEnumerable<string> Names => Index.Keys;

    public static bool TryParse(string name, out int solverFace) => Index.TryGetValue(name, out solverFace);

    public static bool IsValid(string name) => Index.ContainsKey(name);
}
