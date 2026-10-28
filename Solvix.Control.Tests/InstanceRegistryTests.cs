using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class TestTime : TimeProvider
{
    public DateTimeOffset Now { get; set; } = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => Now;
    public void Advance(TimeSpan by) => Now += by;
}

public class InstanceRegistryTests
{
    private static InstanceRegistration Reg(string id = "api-1", long requests = 0, DateTimeOffset? started = null) =>
        new(id, "api", "host", 100, null, "host", ["http://localhost:5168"], "1.0", "Development",
            started ?? new DateTimeOffset(2026, 1, 1, 11, 0, 0, TimeSpan.Zero),
            new InstanceMetrics(100, 1, 20, requests, 0));

    [Test]
    public void Fresh_registration_is_alive()
    {
        var registry = new InstanceRegistry(new TestTime());
        registry.Upsert(Reg());

        Assert.That(registry.Snapshot().Single().Health, Is.EqualTo(InstanceHealth.Alive));
    }

    [Test]
    public void Silent_instance_turns_unresponsive_then_is_forgotten()
    {
        var time = new TestTime();
        var registry = new InstanceRegistry(time);
        registry.Upsert(Reg());

        time.Advance(InstanceRegistry.AliveWindow + TimeSpan.FromSeconds(1));
        Assert.That(registry.Snapshot().Single().Health, Is.EqualTo(InstanceHealth.Unresponsive));

        time.Advance(InstanceRegistry.ForgetAfter);
        Assert.That(registry.Snapshot(), Is.Empty);
    }

    [Test]
    public void Heartbeat_refreshes_the_same_instance_instead_of_adding_one()
    {
        var time = new TestTime();
        var registry = new InstanceRegistry(time);
        registry.Upsert(Reg());
        time.Advance(TimeSpan.FromSeconds(10));
        registry.Upsert(Reg());

        Assert.That(registry.Snapshot(), Has.Count.EqualTo(1));
    }

    [Test]
    public void Requests_per_second_comes_from_the_counter_delta()
    {
        var time = new TestTime();
        var registry = new InstanceRegistry(time);
        registry.Upsert(Reg(requests: 100));
        time.Advance(TimeSpan.FromSeconds(5));
        registry.Upsert(Reg(requests: 150));

        Assert.That(registry.Snapshot().Single().RequestsPerSecond, Is.EqualTo(10).Within(0.001));
    }

    [Test]
    public void Restarted_instance_does_not_produce_a_negative_or_bogus_rate()
    {
        var time = new TestTime();
        var registry = new InstanceRegistry(time);
        registry.Upsert(Reg(requests: 1000));
        time.Advance(TimeSpan.FromSeconds(5));
        registry.Upsert(Reg(requests: 3, started: time.Now));

        Assert.That(registry.Snapshot().Single().RequestsPerSecond, Is.Zero);
    }

    [Test]
    public void Remove_drops_the_instance_immediately()
    {
        var registry = new InstanceRegistry(new TestTime());
        registry.Upsert(Reg());

        Assert.That(registry.Remove("api-1"), Is.True);
        Assert.That(registry.Snapshot(), Is.Empty);
        Assert.That(registry.Remove("api-1"), Is.False);
    }
}
