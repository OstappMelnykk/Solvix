using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Solvix.Data;

namespace Solvix.Api.Tests;

public class MeshEditorApiTests
{
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    [SetUp]
    public void SetUp()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureServices(services =>
            {
                var options = services.Where(d => d.ServiceType == typeof(DbContextOptions<SolvixDbContext>)).ToList();
                foreach (var d in options) services.Remove(d);
                services.AddDbContext<SolvixDbContext>(o => o.UseInMemoryDatabase("mesh-editor-tests-" + Guid.NewGuid()));
            }));
        _client = _factory.CreateClient();
    }

    [TearDown]
    public void TearDown()
    {
        _client.Dispose();
        _factory.Dispose();
    }

    private static JsonElement Root(HttpResponseMessage response) => response.Content.ReadFromJsonAsync<JsonElement>().Result;

    private async Task<JsonElement> Post(string url, object? body = null)
    {
        var response = await _client.PostAsJsonAsync(url, body ?? new { });
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK), url);
        return Root(response);
    }

    [Test]
    public async Task A_new_session_state_is_empty()
    {
        var response = await _client.GetAsync("/api/mesh-editor/1/state");

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var state = Root(response);
        Assert.That(state.GetProperty("hexes").GetArrayLength(), Is.EqualTo(0));
        Assert.That(state.GetProperty("canUndo").GetBoolean(), Is.False);
    }

    [Test]
    public async Task Building_linking_moving_and_undoing_over_http()
    {
        var first = await Post("/api/mesh-editor/1/hexes/first");
        Assert.That(first.GetProperty("ok").GetBoolean(), Is.True);
        Assert.That(first.GetProperty("state").GetProperty("nodes").GetArrayLength(), Is.EqualTo(20));

        var second = await Post("/api/mesh-editor/1/hexes/0/faces/XPlus/attach");
        Assert.That(second.GetProperty("state").GetProperty("nodes").GetArrayLength(), Is.EqualTo(32));
        Assert.That(second.GetProperty("state").GetProperty("links").GetArrayLength(), Is.EqualTo(1));

        var shared = second.GetProperty("state").GetProperty("hexes")[0].GetProperty("nodeIds")[1].GetInt32();
        var moved = await _client.PutAsJsonAsync($"/api/mesh-editor/1/nodes/{shared}", new { x = 1.0, y = -0.25, z = 0.0, carryEdgeMidpoints = true });
        Assert.That(moved.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(Root(moved).GetProperty("ok").GetBoolean(), Is.True);

        var undone = await Post("/api/mesh-editor/1/undo");
        Assert.That(undone.GetProperty("ok").GetBoolean(), Is.True);
        var state = Root(await _client.GetAsync("/api/mesh-editor/1/state"));
        var node = state.GetProperty("nodes").EnumerateArray().Single(n => n.GetProperty("id").GetInt32() == shared);
        Assert.That(node.GetProperty("y").GetDouble(), Is.EqualTo(0.0));
    }

    [Test]
    public async Task A_refused_command_is_a_normal_200_with_ok_false_and_a_reason()
    {
        await Post("/api/mesh-editor/1/hexes/first");

        var result = await Post("/api/mesh-editor/1/hexes/0/faces/Sideways/attach");

        Assert.That(result.GetProperty("ok").GetBoolean(), Is.False);
        Assert.That(result.GetProperty("error").GetString(), Does.Contain("Unknown face"));
        Assert.That(result.GetProperty("state").GetProperty("hexes").GetArrayLength(), Is.EqualTo(1));
    }

    [Test]
    public async Task Linking_and_unlinking_faces_over_http()
    {
        await Post("/api/mesh-editor/1/hexes/first");
        await Post("/api/mesh-editor/1/hexes/0/faces/XPlus/attach");
        await Post("/api/mesh-editor/1/hexes/1/faces/YPlus/attach");
        await Post("/api/mesh-editor/1/hexes/0/faces/YPlus/attach");

        var link = await Post("/api/mesh-editor/1/links", new { hexA = 3, faceA = "XPlus", hexB = 2, faceB = "XMinus", adaptSecond = false });
        Assert.That(link.GetProperty("ok").GetBoolean(), Is.True, link.GetProperty("error").ToString());
        Assert.That(link.GetProperty("state").GetProperty("links").GetArrayLength(), Is.EqualTo(4));

        var unlink = await _client.DeleteAsync("/api/mesh-editor/1/hexes/3/faces/XPlus/link");
        Assert.That(unlink.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(Root(unlink).GetProperty("state").GetProperty("links").GetArrayLength(), Is.EqualTo(3));
    }

    [Test]
    public async Task Mapping_endpoints_round_trip()
    {
        await Post("/api/mesh-editor/1/hexes/first");
        await Post("/api/mesh-editor/1/hexes/0/faces/XPlus/attach");

        var real = await Post("/api/mesh-editor/1/map/ideal-to-real", new { x = 1.25, y = 0.5, z = 0.5 });
        Assert.That(real.GetProperty("found").GetBoolean(), Is.True);
        var p = real.GetProperty("point");
        var back = await Post("/api/mesh-editor/1/map/real-to-ideal", new { x = p.GetProperty("x").GetDouble(), y = p.GetProperty("y").GetDouble(), z = p.GetProperty("z").GetDouble() });

        Assert.That(back.GetProperty("point").GetProperty("x").GetDouble(), Is.EqualTo(1.25).Within(1e-7));
        var outside = await Post("/api/mesh-editor/1/map/ideal-to-real", new { x = 7.0, y = 7.0, z = 7.0 });
        Assert.That(outside.GetProperty("found").GetBoolean(), Is.False);
    }

    [Test]
    public async Task Sessions_are_separate_over_http()
    {
        await Post("/api/mesh-editor/1/hexes/first");

        var other = Root(await _client.GetAsync("/api/mesh-editor/2/state"));

        Assert.That(other.GetProperty("hexes").GetArrayLength(), Is.EqualTo(0));
    }

    [Test]
    public async Task A_non_numeric_session_id_is_a_404_not_a_crash()
    {
        var response = await _client.GetAsync("/api/mesh-editor/abc/state");

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }

    [Test]
    public async Task Linking_two_cubes_by_id_over_http()
    {
        await Post("/api/mesh-editor/1/hexes/first");
        await Post("/api/mesh-editor/1/hexes/0/faces/XPlus/attach");
        await Post("/api/mesh-editor/1/hexes/1/faces/YPlus/attach");
        await Post("/api/mesh-editor/1/hexes/0/faces/YPlus/attach");

        var link = await Post("/api/mesh-editor/1/links/by-hexes", new { hexA = 3, hexB = 2, adaptSecond = false });

        Assert.That(link.GetProperty("ok").GetBoolean(), Is.True, link.GetProperty("error").ToString());
        Assert.That(link.GetProperty("state").GetProperty("links").GetArrayLength(), Is.EqualTo(4));
    }

    [Test]
    public async Task Deleting_a_cube_over_http_refuses_a_bridge_and_accepts_a_leaf()
    {
        await Post("/api/mesh-editor/1/hexes/first");
        await Post("/api/mesh-editor/1/hexes/0/faces/XPlus/attach");
        await Post("/api/mesh-editor/1/hexes/1/faces/XPlus/attach");

        var bridge = Root(await _client.DeleteAsync("/api/mesh-editor/1/hexes/1"));
        Assert.That(bridge.GetProperty("ok").GetBoolean(), Is.False);
        Assert.That(bridge.GetProperty("error").GetString(), Does.Contain("split the body"));

        var leaf = Root(await _client.DeleteAsync("/api/mesh-editor/1/hexes/2"));
        Assert.That(leaf.GetProperty("ok").GetBoolean(), Is.True);
        Assert.That(leaf.GetProperty("state").GetProperty("hexes").GetArrayLength(), Is.EqualTo(2));
    }

    [Test]
    public async Task Moving_a_node_without_naming_the_carry_flag_moves_only_that_node()
    {
        var first = await Post("/api/mesh-editor/1/hexes/first");
        var nodes = first.GetProperty("state").GetProperty("nodes").EnumerateArray().ToList();
        var corner = nodes.Single(n => n.GetProperty("x").GetDouble() == 0 && n.GetProperty("y").GetDouble() == 0 && n.GetProperty("z").GetDouble() == 0);

        var moved = await _client.PutAsJsonAsync($"/api/mesh-editor/1/nodes/{corner.GetProperty("id").GetInt32()}", new { x = -0.4, y = -0.3, z = -0.2 });
        var after = Root(moved).GetProperty("state").GetProperty("nodes").EnumerateArray().ToList();

        foreach (var node in nodes)
        {
            int id = node.GetProperty("id").GetInt32();
            var now = after.Single(n => n.GetProperty("id").GetInt32() == id);
            bool isMoved = id == corner.GetProperty("id").GetInt32();
            Assert.That(now.GetProperty("x").GetDouble(), Is.EqualTo(isMoved ? -0.4 : node.GetProperty("x").GetDouble()), $"node {id}");
        }
    }

    [Test]
    public async Task Deleting_a_session_over_http_returns_no_content_and_starts_it_over()
    {
        await Post("/api/mesh-editor/1/hexes/first");
        await Post("/api/mesh-editor/2/hexes/first");

        var response = await _client.DeleteAsync("/api/mesh-editor/1");

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NoContent));
        var state = Root(await _client.GetAsync("/api/mesh-editor/1/state"));
        Assert.That(state.GetProperty("hexes").GetArrayLength(), Is.EqualTo(0));
        Assert.That(state.GetProperty("canUndo").GetBoolean(), Is.False);
        Assert.That(Root(await _client.GetAsync("/api/mesh-editor/2/state")).GetProperty("hexes").GetArrayLength(), Is.EqualTo(1));
    }
}
