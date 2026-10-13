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
}
