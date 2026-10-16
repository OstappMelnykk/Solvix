using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Solvix.Data;

namespace Solvix.Api.Tests;

public class SolverApiTests
{
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    [SetUp]
    public void SetUp()
    {
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.ConfigureServices(services =>
            {
                foreach (var d in services.Where(d => d.ServiceType == typeof(DbContextOptions<SolvixDbContext>)).ToList()) services.Remove(d);
                services.AddDbContext<SolvixDbContext>(o => o.UseInMemoryDatabase("solver-tests-" + Guid.NewGuid()));
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

    private async Task<JsonElement> Send(HttpMethod method, string url, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await _client.SendAsync(request);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK), url);
        return Root(response);
    }

    private async Task BuildBar(int cubes)
    {
        await Send(HttpMethod.Post, "/api/mesh-editor/1/hexes/first");
        for (int i = 1; i < cubes; i++) await Send(HttpMethod.Post, $"/api/mesh-editor/1/hexes/{i - 1}/faces/XPlus/attach");
    }

    private async Task<JsonElement> WaitForJob()
    {
        for (int i = 0; i < 600; i++)
        {
            var job = await Send(HttpMethod.Get, "/api/solver/1/job");
            if (job.GetProperty("state").GetString() != "running") return job;
            await Task.Delay(20);
        }
        Assert.Fail("The solve did not finish.");
        return default;
    }

    [Test]
    public async Task A_new_session_starts_with_the_material_library_and_nothing_set()
    {
        var setup = await Send(HttpMethod.Get, "/api/solver/1/setup");

        Assert.That(setup.GetProperty("materials").EnumerateArray().Select(m => m.GetProperty("name").GetString()), Does.Contain("steel").And.Contain("rubber"));
        Assert.That(setup.GetProperty("defaultMaterial").GetString(), Is.EqualTo("steel"));
        Assert.That(setup.GetProperty("fixed").GetArrayLength(), Is.EqualTo(0));
        Assert.That(setup.GetProperty("loads").GetArrayLength(), Is.EqualTo(0));
    }

    [Test]
    public async Task The_whole_flow_set_up_validate_solve_poll_and_read_the_result()
    {
        await BuildBar(3);
        await Send(HttpMethod.Put, "/api/solver/1/hexes/material", new { hexIds = new[] { 2 }, material = "rubber" });
        await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus" } }, fixedFaces = true, @fixed = true });
        var setup = await Send(HttpMethod.Put, "/api/solver/1/faces/load", new { faces = new[] { new { hex = 2, face = "XPlus" } }, pressure = 1e5 });
        Assert.That(setup.GetProperty("loads").GetArrayLength(), Is.EqualTo(1));
        Assert.That(setup.GetProperty("fixed").GetArrayLength(), Is.EqualTo(1));

        var validation = await Send(HttpMethod.Post, "/api/solver/1/validate");
        Assert.That(validation.GetProperty("canSolve").GetBoolean(), Is.True);

        var started = await Send(HttpMethod.Post, "/api/solver/1/solve");
        Assert.That(started.GetProperty("state").GetString(), Is.EqualTo("running"));
        var job = await WaitForJob();
        Assert.That(job.GetProperty("state").GetString(), Is.EqualTo("done"), job.ToString());

        var result = await Send(HttpMethod.Get, "/api/solver/1/result");
        Assert.That(result.GetProperty("positions").GetArrayLength(), Is.EqualTo(3 * result.GetProperty("ux").GetArrayLength()));
        Assert.That(result.GetProperty("divisions").EnumerateArray().Select(d => d.GetInt32()), Is.EqualTo(new[] { 1, 1, 1 }));
        Assert.That(result.GetProperty("hexIds").GetArrayLength(), Is.EqualTo(3));
        Assert.That(result.GetProperty("maxDisplacement").GetDouble(), Is.GreaterThan(0));
        Assert.That(result.GetProperty("maxVonMises").GetDouble(), Is.GreaterThan(0));
    }

    [Test]
    public async Task The_division_is_set_and_ends_up_in_the_result()
    {
        await BuildBar(2);
        var setup = await Send(HttpMethod.Put, "/api/solver/1/divisions", new { nx = 2, ny = 1, nz = 2 });
        Assert.That(setup.GetProperty("divisions").EnumerateArray().Select(d => d.GetInt32()), Is.EqualTo(new[] { 2, 1, 2 }));
        await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus" } }, @fixed = true });
        await Send(HttpMethod.Put, "/api/solver/1/faces/load", new { faces = new[] { new { hex = 1, face = "XPlus" } }, pressure = -1e5 });

        await Send(HttpMethod.Post, "/api/solver/1/solve");
        var job = await WaitForJob();

        Assert.That(job.GetProperty("state").GetString(), Is.EqualTo("done"), job.ToString());
        var result = await Send(HttpMethod.Get, "/api/solver/1/result");
        Assert.That(result.GetProperty("divisions").EnumerateArray().Select(d => d.GetInt32()), Is.EqualTo(new[] { 2, 1, 2 }));
        Assert.That(result.GetProperty("ux").GetArrayLength(), Is.GreaterThan(40));
    }

    [Test]
    public async Task Solving_without_a_support_is_a_failed_job_with_the_reason_not_an_http_error()
    {
        await BuildBar(2);

        var job = await Send(HttpMethod.Post, "/api/solver/1/solve");

        Assert.That(job.GetProperty("state").GetString(), Is.EqualTo("failed"));
        Assert.That(job.GetProperty("error").GetString(), Does.Contain("Закріпіть"));
    }

    [Test]
    public async Task Validation_lists_the_issues_with_their_severity()
    {
        await BuildBar(2);

        var validation = await Send(HttpMethod.Post, "/api/solver/1/validate");

        Assert.That(validation.GetProperty("canSolve").GetBoolean(), Is.False);
        Assert.That(validation.GetProperty("issues").EnumerateArray().Select(i => i.GetProperty("severity").GetString()), Does.Contain("error").And.Contain("warning"));
    }

    [Test]
    public async Task There_is_no_result_before_a_solve()
    {
        var response = await _client.GetAsync("/api/solver/1/result");

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }

    [Test]
    public async Task Resetting_the_mesh_forgets_the_supports_and_loads_set_for_the_old_cubes()
    {
        await BuildBar(2);
        await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus" } }, @fixed = true });

        await Send(HttpMethod.Post, "/api/mesh-editor/1/reset");

        var setup = await Send(HttpMethod.Get, "/api/solver/1/setup");
        Assert.That(setup.GetProperty("fixed").GetArrayLength(), Is.EqualTo(0));
    }

    [Test]
    public async Task Dropping_a_session_drops_its_setup_too()
    {
        await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus" } }, @fixed = true });

        var response = await _client.DeleteAsync("/api/mesh-editor/1");
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NoContent));

        Assert.That((await Send(HttpMethod.Get, "/api/solver/1/setup")).GetProperty("fixed").GetArrayLength(), Is.EqualTo(0));
    }

    [Test]
    public async Task A_bad_material_is_ignored_and_a_good_one_is_stored()
    {
        await Send(HttpMethod.Put, "/api/solver/1/materials", new { name = "bad", label = "Bad", e = -5.0, nu = 0.3 });
        var setup = await Send(HttpMethod.Put, "/api/solver/1/materials", new { name = "glass", label = "Скло", e = 7e10, nu = 0.22 });

        var names = setup.GetProperty("materials").EnumerateArray().Select(m => m.GetProperty("name").GetString()).ToList();
        Assert.That(names, Does.Contain("glass"));
        Assert.That(names, Does.Not.Contain("bad"));
    }

    [Test]
    public async Task A_side_chosen_as_a_whole_replaces_the_faces_chosen_before()
    {
        await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus" } }, @fixed = true });
        var fixedNow = await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 1, face = "ZMinus" } }, replace = true });
        await Send(HttpMethod.Put, "/api/solver/1/faces/load", new { faces = new[] { new { hex = 0, face = "XPlus" } }, pressure = -1e6 });
        var loadedNow = await Send(HttpMethod.Put, "/api/solver/1/faces/load", new { faces = new[] { new { hex = 1, face = "ZPlus" } }, pressure = -2e6, replace = true });

        Assert.That(fixedNow.GetProperty("fixed").GetArrayLength(), Is.EqualTo(1));
        Assert.That(fixedNow.GetProperty("fixed")[0].GetProperty("face").GetString(), Is.EqualTo("ZMinus"));
        Assert.That(loadedNow.GetProperty("loads").GetArrayLength(), Is.EqualTo(1));
        Assert.That(loadedNow.GetProperty("loads")[0].GetProperty("pressure").GetDouble(), Is.EqualTo(-2e6));
    }

    [Test]
    public async Task A_single_small_face_and_a_single_small_element_can_be_set_over_http()
    {
        await Send(HttpMethod.Put, "/api/solver/1/divisions", new { nx = 2, ny = 2, nz = 2 });

        var faces = await Send(HttpMethod.Put, "/api/solver/1/faces/fixed", new { faces = new[] { new { hex = 0, face = "XMinus", p = 1, q = 0 } }, @fixed = true });
        var materials = await Send(HttpMethod.Put, "/api/solver/1/elements/material", new { elements = new[] { new { hex = 0, ex = 1, ey = 0, ez = 1 } }, material = "rubber" });

        Assert.That(faces.GetProperty("fixed").GetArrayLength(), Is.EqualTo(1));
        Assert.That(faces.GetProperty("fixed")[0].GetProperty("p").GetInt32(), Is.EqualTo(1));
        Assert.That(faces.GetProperty("fixed")[0].GetProperty("q").GetInt32(), Is.EqualTo(0));
        Assert.That(materials.GetProperty("elementMaterials").GetArrayLength(), Is.EqualTo(1));
        Assert.That(materials.GetProperty("elementMaterials")[0].GetProperty("material").GetString(), Is.EqualTo("rubber"));
    }

    // ---- the local refinement, over HTTP ----

    private async Task<HttpResponseMessage> Raw(HttpMethod method, string url, object? body = null)
    {
        var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body);
        return await _client.SendAsync(request);
    }

    private static IEnumerable<(int Element, int Face)> Pairs(JsonElement array)
    {
        var values = array.EnumerateArray().Select(v => v.GetInt32()).ToList();
        for (int i = 0; i < values.Count; i += 2) yield return (values[i], values[i + 1]);
    }

    [Test]
    public async Task A_cube_refined_locally_gives_a_mesh_whose_faces_can_be_pointed_at_and_solved()
    {
        await BuildBar(3);
        await Send(HttpMethod.Put, "/api/solver/1/hexes/material", new { hexIds = new[] { 99 }, material = "rubber" });         // nothing: no such cube

        var setup = await Send(HttpMethod.Post, "/api/solver/1/refinement", new { leaves = new[] { "hex:1" }, ni = 2, nj = 2, nk = 2, transitionDepth = 0 });
        Assert.That(setup.GetProperty("refinements").GetArrayLength(), Is.EqualTo(1));

        var mesh = await Send(HttpMethod.Get, "/api/solver/1/mesh");
        int elements = mesh.GetProperty("elementCount").GetInt32();
        Assert.That(elements, Is.GreaterThan(3 + 7));
        Assert.That(mesh.GetProperty("rule").GetString(), Does.Contain("local"));
        var keys = mesh.GetProperty("keys").EnumerateArray().Select(k => k.GetString()!).ToList();
        var hexIds = mesh.GetProperty("hexIds").EnumerateArray().Select(h => h.GetInt32()).ToList();
        var surface = Pairs(mesh.GetProperty("surfaceFaces")).ToList();

        // a face of the refined cube's top, as a click would name it: its element's key and its local face
        var top = surface.First(f => f.Face == 1 && hexIds[f.Element] == 1);
        var fixedSetup = await Send(HttpMethod.Put, "/api/solver/1/mesh/faces", new { faces = new[] { new { key = keys[top.Element], face = top.Face } }, action = "fix" });
        Assert.That(fixedSetup.GetProperty("canUndo").GetBoolean(), Is.True);
        var after = await Send(HttpMethod.Get, "/api/solver/1/mesh");
        Assert.That(Pairs(after.GetProperty("fixedFaces")).ToList(), Is.EqualTo(new[] { top }), "exactly the face that was pointed at");

        // the material of one small element
        await Send(HttpMethod.Put, "/api/solver/1/mesh/elements/material", new { elementKeys = new[] { keys[top.Element] }, material = "rubber" });
        var painted = await Send(HttpMethod.Get, "/api/solver/1/mesh");
        Assert.That(painted.GetProperty("materials").EnumerateArray().Select(m => m.GetString()).Count(m => m == "rubber"), Is.EqualTo(1));

        // clamp an end and pull the other, solve, read the result: it is on the same nodes as the mesh
        var end0 = surface.Where(f => f.Face == 4 && hexIds[f.Element] == 0).Select(f => new { key = keys[f.Element], face = f.Face }).ToList();
        var end2 = surface.Where(f => f.Face == 5 && hexIds[f.Element] == 2).Select(f => new { key = keys[f.Element], face = f.Face }).ToList();
        await Send(HttpMethod.Put, "/api/solver/1/mesh/faces", new { faces = end0, action = "fix" });
        await Send(HttpMethod.Put, "/api/solver/1/mesh/faces", new { faces = end2, action = "load", pressure = 1e5 });
        var validation = await Send(HttpMethod.Post, "/api/solver/1/validate");
        Assert.That(validation.GetProperty("canSolve").GetBoolean(), Is.True, validation.ToString());

        await Send(HttpMethod.Post, "/api/solver/1/solve");
        var job = await WaitForJob();
        Assert.That(job.GetProperty("state").GetString(), Is.EqualTo("done"), job.ToString());
        var result = await Send(HttpMethod.Get, "/api/solver/1/result");
        Assert.That(result.GetProperty("ux").GetArrayLength(), Is.EqualTo(mesh.GetProperty("nodeCount").GetInt32()));
        Assert.That(result.GetProperty("gridNodes").GetArrayLength(), Is.EqualTo(0));
    }

    [Test]
    public async Task A_refinement_that_cannot_be_done_is_a_400_with_the_reason_and_changes_nothing()
    {
        await BuildBar(2);

        var nothing = await Raw(HttpMethod.Post, "/api/solver/1/refinement", new { leaves = Array.Empty<string>(), ni = 2, nj = 2, nk = 2 });
        var one = await Raw(HttpMethod.Post, "/api/solver/1/refinement", new { leaves = new[] { "hex:0" }, ni = 0, nj = 2, nk = 2 });
        var gone = await Raw(HttpMethod.Post, "/api/solver/1/refinement", new { leaves = new[] { "hex:77" }, ni = 2, nj = 2, nk = 2 });

        foreach (var response in new[] { nothing, one, gone })
        {
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
            Assert.That(Root(response).GetProperty("error").GetString(), Is.Not.Empty);
        }
        var setup = await Send(HttpMethod.Get, "/api/solver/1/setup");
        Assert.That(setup.TryGetProperty("refinements", out var r) && r.ValueKind == JsonValueKind.Array && r.GetArrayLength() > 0, Is.False);
    }

    [Test]
    public async Task The_refinement_can_be_taken_away_and_the_mesh_is_cut_evenly_again()
    {
        await BuildBar(2);
        await Send(HttpMethod.Post, "/api/solver/1/refinement", new { leaves = new[] { "hex:0" }, ni = 3, nj = 3, nk = 3 });
        var refined = await Send(HttpMethod.Get, "/api/solver/1/mesh");

        var setup = await Send(HttpMethod.Delete, "/api/solver/1/refinement");
        var even = await Send(HttpMethod.Get, "/api/solver/1/mesh");

        Assert.That(refined.GetProperty("elementCount").GetInt32(), Is.GreaterThan(2));
        Assert.That(setup.TryGetProperty("refinements", out var r) && r.ValueKind == JsonValueKind.Array, Is.False);
        Assert.That(even.GetProperty("elementCount").GetInt32(), Is.EqualTo(2));
        Assert.That(even.GetProperty("rule").GetString(), Does.Contain("uniform"));
    }
}
