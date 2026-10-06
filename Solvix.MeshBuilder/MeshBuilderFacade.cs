using Solvix.Contracts.Facades;

namespace Solvix.MeshBuilder;

// Facade (GoF): exposes a simplified, stable surface to callers
// (Solvix.Api) - callers depend only on IMeshBuilderFacade (defined in
// Solvix.Contracts), never on this concrete class. Internal - only
// AddMeshBuilder() ever names this type; Api resolves it purely through the
// interface.
internal sealed class MeshBuilderFacade : IMeshBuilderFacade
{
}
