using Microsoft.EntityFrameworkCore;

namespace Solvix.Data;

public class SolvixDbContext : DbContext
{
    public SolvixDbContext(DbContextOptions<SolvixDbContext> options) : base(options)
    {
    }

    public DbSet<ModelLibraryEntry> ModelLibraryEntries => Set<ModelLibraryEntry>();
}