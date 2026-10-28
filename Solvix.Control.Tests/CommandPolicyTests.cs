using Microsoft.Extensions.Configuration;
using Solvix.Control.Services;

namespace Solvix.Control.Tests;

public class CommandPolicyTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "solvix-policy-tests");

    private static CommandPolicy Policy()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Control:RepoRoot"] = Root }).Build();
        return new CommandPolicy(new ControlPaths(config));
    }

    private static PolicyDecision Check(string line) => Policy().Evaluate(TerminalService.Tokenize(line));

    [TestCase("docker ps")]
    [TestCase("docker ps -a")]
    [TestCase("docker logs --tail 50 solvix-1-api-1")]
    [TestCase("docker logs -f solvix-1-api-1")]
    [TestCase("docker stats --no-stream")]
    [TestCase("docker inspect solvix-1-web-1")]
    [TestCase("docker volume ls")]
    [TestCase("docker network inspect solvix-1_default")]
    [TestCase("docker system df")]
    [TestCase("docker compose ls")]
    [TestCase("docker compose -p solvix-1 ps")]
    [TestCase("docker compose -p solvix-1 logs api")]
    [TestCase("solvix status")]
    [TestCase("solvix stack up 1")]
    [TestCase("solvix stack ls")]
    [TestCase("solvix logs stack 1 api")]
    [TestCase("git status")]
    [TestCase("git log --oneline -5")]
    [TestCase("git diff")]
    [TestCase("git branch --show-current")]
    [TestCase("lsof -iTCP -sTCP:LISTEN -nP")]
    [TestCase("ps -ax")]
    [TestCase("df -h")]
    [TestCase("ls")]
    [TestCase("ls -la scripts")]
    [TestCase("cat README.md")]
    [TestCase("tail -n 20 .solvix/logs/solvix.log")]
    [TestCase("grep -rn health Solvix.Api")]
    [TestCase("find . -name *.cs")]
    [TestCase("curl -s http://localhost:5171/api/health")]
    [TestCase("ping -c 3 localhost")]
    [TestCase("dotnet --info")]
    [TestCase("colima status")]
    [TestCase("node -v")]
    public void Read_only_commands_are_allowed(string line)
    {
        var decision = Check(line);

        Assert.That(decision.Allowed, Is.True, decision.Reason);
    }

    [TestCase("rm -rf /")]
    [TestCase("rm file")]
    [TestCase("sudo ls")]
    [TestCase("bash -c ls")]
    [TestCase("sh")]
    [TestCase("python3 -c 1")]
    [TestCase("/bin/ls")]
    [TestCase("./ls")]
    [TestCase("mv a b")]
    [TestCase("chmod 777 x")]
    [TestCase("kill 1")]
    [TestCase("env")]
    [TestCase("docker rm -f solvix-1-api-1")]
    [TestCase("docker run -it ubuntu bash")]
    [TestCase("docker exec -it solvix-1-api-1 sh")]
    [TestCase("docker stop x")]
    [TestCase("docker system prune -af")]
    [TestCase("docker volume rm solvix_stack1_postgres_data")]
    [TestCase("docker volume prune")]
    [TestCase("docker -H tcp://evil:2375 ps")]
    [TestCase("docker stats")]
    [TestCase("docker compose down -v")]
    [TestCase("docker compose -p solvix-1 down")]
    [TestCase("docker compose up -d")]
    [TestCase("solvix reset")]
    [TestCase("solvix stack rm 1")]
    [TestCase("git push")]
    [TestCase("git commit -am x")]
    [TestCase("git checkout main")]
    [TestCase("git reset --hard")]
    [TestCase("git branch -D x")]
    [TestCase("git diff --output=/tmp/x")]
    [TestCase("git -c core.pager=sh log")]
    [TestCase("date -s 2020-01-01")]
    [TestCase("hostname evil")]
    [TestCase("ifconfig en0 down")]
    [TestCase("ping localhost")]
    [TestCase("curl https://example.com")]
    [TestCase("curl -X POST http://localhost:5171/api/x")]
    [TestCase("curl -d x http://localhost:5171/api/x")]
    [TestCase("curl -o /tmp/x http://localhost:5171/")]
    [TestCase("find . -delete")]
    [TestCase("find . -exec rm {} ;")]
    [TestCase("cat /etc/passwd")]
    [TestCase("cat ../../../etc/hosts")]
    [TestCase("cat ~/.ssh/id_rsa")]
    [TestCase("cat /Users/ostap/.ssh/id_rsa")]
    [TestCase("cat .env")]
    [TestCase("ls /")]
    [TestCase("grep root /etc/passwd")]
    [TestCase("grep -f /etc/passwd x")]
    [TestCase("npm install")]
    [TestCase("dotnet build")]
    [TestCase("node script.js")]
    public void Anything_that_writes_deletes_or_reads_secrets_is_refused(string line)
    {
        var decision = Check(line);

        Assert.That(decision.Allowed, Is.False, $"'{line}' must be denied");
        Assert.That(decision.Reason, Is.Not.Empty);
    }

    [Test]
    public void Solvix_maps_to_the_launcher_script()
    {
        var decision = Check("solvix status");

        Assert.That(decision.Command!.File, Is.EqualTo(Path.Combine(Root, "scripts", "solvix")));
    }

    [Test]
    public void Shell_syntax_is_inert_text_not_a_second_command()
    {
        // No shell is involved: `;` stays part of an argument that docker/ls then rejects or ignores.
        Assert.That(Check("ls ; rm -rf /").Allowed, Is.False);
        Assert.That(Check("docker ps && rm -rf /").Allowed, Is.True);
        Assert.That(Check("docker ps && rm -rf /").Command!.Args, Is.EqualTo(new[] { "ps", "&&", "rm", "-rf", "/" }));
    }
}
