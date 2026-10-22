using Solvix.Control.Models;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class LogStoreTests
{
    private static LogEntry Entry(string level, string message, string instance = "api-1") =>
        new(DateTimeOffset.UnixEpoch, level, "Test", message, null, instance);

    [Test]
    public void Query_filters_by_level_instance_and_text()
    {
        var store = LogStore.InMemory(new TestTime());
        store.Add([
            Entry("Information", "started"),
            Entry("Warning", "slow query"),
            Entry("Error", "boom", "api-2"),
        ]);

        Assert.That(store.Query(new LogFilter("Warning")).Select(e => e.Message), Is.EqualTo(new[] { "slow query", "boom" }));
        Assert.That(store.Query(new LogFilter(InstanceId: "api-2")).Single().Message, Is.EqualTo("boom"));
        Assert.That(store.Query(new LogFilter(Text: "SLOW")).Single().Message, Is.EqualTo("slow query"));
    }

    [Test]
    public void Take_keeps_the_most_recent_matches_in_chronological_order()
    {
        var store = LogStore.InMemory(new TestTime());
        store.Add(Enumerable.Range(1, 10).Select(i => Entry("Information", $"m{i}")).ToList());

        Assert.That(store.Query(new LogFilter(Take: 3)).Select(e => e.Message), Is.EqualTo(new[] { "m8", "m9", "m10" }));
    }

    [Test]
    public void History_survives_a_restart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "solvix-logs-" + Guid.NewGuid());
        Directory.CreateDirectory(dir);
        try
        {
            new LogStore(dir, new TestTime()).Add([Entry("Information", "kept")]);

            var reloaded = new LogStore(dir, new TestTime());
            Assert.That(reloaded.Query(new LogFilter()).Single().Message, Is.EqualTo("kept"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
