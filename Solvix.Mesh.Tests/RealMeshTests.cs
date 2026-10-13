using System.Text.Json;
using NUnit.Framework;

namespace Solvix.Mesh.Tests;

/// <summary>
/// A mesh a user could not improve: 3 x 3 x 3 cubes with the corners almost on the lattice but the midpoints of many
/// edges pulled far off (up to 0.57 of the edge), which folded 15 of the 27 cubes. Smoothing used to refuse it (it only
/// moved corners) - see Fixtures/folded-by-bent-midpoints.json, the state as the editor's API sent it.
/// </summary>
public class RealMeshTests
{
    private static HexMesh Load()
    {
        var path = Path.Combine(TestContext.CurrentContext.TestDirectory, "Fixtures", "folded-by-bent-midpoints.json");
        var doc = JsonDocument.Parse(File.ReadAllText(path)).RootElement;
        var nodes = doc.GetProperty("nodes").EnumerateArray()
            .Select(n => new NodeState(n.GetProperty("id").GetInt32(), new Vec3(n.GetProperty("x").GetDouble(), n.GetProperty("y").GetDouble(), n.GetProperty("z").GetDouble()),
                n.GetProperty("idealX").GetInt32(), n.GetProperty("idealY").GetInt32(), n.GetProperty("idealZ").GetInt32())).ToList();
        var hexes = doc.GetProperty("hexes").EnumerateArray()
            .Select(h => new HexState(h.GetProperty("id").GetInt32(), h.GetProperty("cellI").GetInt32(), h.GetProperty("cellJ").GetInt32(), h.GetProperty("cellK").GetInt32(), null,
                h.GetProperty("nodeIds").EnumerateArray().Select(x => x.GetInt32()).ToList())).ToList();
        var links = new List<LinkState>();
        foreach (var l in doc.GetProperty("links").EnumerateArray())
        {
            links.Add(new LinkState(l.GetProperty("hexA").GetInt32(), Enum.Parse<HexFace>(l.GetProperty("faceA").GetString()!), l.GetProperty("hexB").GetInt32()));
            links.Add(new LinkState(l.GetProperty("hexB").GetInt32(), Enum.Parse<HexFace>(l.GetProperty("faceB").GetString()!), l.GetProperty("hexA").GetInt32()));
        }
        return HexMesh.FromState(new HexMeshState(nodes.Max(n => n.Id) + 1, hexes.Max(h => h.Id) + 1, nodes, hexes, links));
    }

    [Test]
    public void The_mesh_really_is_folded_to_begin_with()
    {
        Assert.That(Load().InvalidHexes(), Has.Count.EqualTo(15));
    }

    [Test]
    public void Smoothing_unfolds_all_of_it_and_barely_moves_the_corners()
    {
        var editor = new HexMeshEditor(Load());
        var corners = editor.Mesh.Nodes.Where(n => editor.Mesh.OwnersOf(n.Id).All(o => o.Slot < 8)).ToDictionary(n => n.Id, n => n.Position);

        var result = editor.Smooth(100, 0.5);

        Assert.That(result.Ok, Is.True, result.Error);
        Assert.That(editor.Mesh.InvalidHexes(), Is.Empty);
        Assert.That(result.Info, Does.Contain("Вивернутих кубів: було 15, стало 0"));
        // the cause was the midpoints, so the corners stay where they were (within a fifth of a cube)
        Assert.That(corners.Max(c => (editor.Mesh.Node(c.Key).Position - c.Value).Length), Is.LessThan(0.2));
    }

    [Test]
    public void Without_straightening_the_edges_it_cannot_be_fixed_by_the_corners_alone()
    {
        var editor = new HexMeshEditor(Load());

        editor.Smooth(100, 0.5, straighten: false);

        Assert.That(editor.Mesh.InvalidHexes(), Is.Not.Empty);
    }
}
