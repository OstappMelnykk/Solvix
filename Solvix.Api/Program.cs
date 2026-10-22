using Microsoft.EntityFrameworkCore;
using Solvix.Api;
using Solvix.Api.Control;
using Solvix.Api.ModelLibrary;
using Solvix.Contracts.Facades;
using Solvix.Data;
using Solvix.MeshBuilder;
using Solvix.Solver;

var builder = WebApplication.CreateBuilder(args);

builder.AddControlReporting();

const string frontendCorsPolicy = "Frontend";

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddCors(options =>
{
    options.AddPolicy(frontendCorsPolicy, policy =>
        policy.WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:4200"])
            .AllowAnyHeader()
            .AllowAnyMethod()
            .WithExposedHeaders("X-Shell-Faces", "X-Shell-Triangles", "X-Shell-Deviation")
            .AllowCredentials());   // SignalR's negotiation sends credentials
});

builder.Services.AddDbContext<SolvixDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

builder.Services.AddHealthChecks();
builder.Services.AddMeshBuilder();
builder.Services.AddSignalR();
builder.Services.AddSingleton<ISolverProgressNotifier, SignalRSolverNotifier>();
builder.Services.AddSolver();
builder.Services.AddScoped<Solvix.Bridge.Bridge>();

builder.Services.Configure<ModelLibraryStorageOptions>(builder.Configuration.GetSection("ModelLibrary"));
builder.Services.AddSingleton<ModelLibraryStorage>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<SolvixDbContext>();
    if (db.Database.IsRelational())
    {
        db.Database.Migrate();
    }
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
    app.UseHttpsRedirection();   // the Production container serves plain http behind nginx
}

app.UseControlReporting();
app.UseCors(frontendCorsPolicy);

app.MapControllers();
app.MapHealthChecks("/api/health");   // ./scripts/solvix and the web container probe this
app.MapHub<SolverHub>("/hubs/solver");

app.Run();

// Lets Solvix.Api.Tests host the app in-process (WebApplicationFactory<Program>).
public partial class Program;
