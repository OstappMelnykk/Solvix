# Voxelization performance: parallelizing `VoxelizationService.Voxelize`

## Change

`VoxelizationService.Voxelize` (`Solvix.Voxelization/VoxelizationService.cs`) decides
inclusion for every grid cell independently (`IsCubeIncluded`), reading only a
`TriangleSpatialGrid` that's fully built and read-only by the time the per-cell loop
runs. The outer X-slice loop was converted from a sequential `for` to `Parallel.For`.

The one piece of shared mutable state, the packed occupancy bitmask, could not be
written directly from parallel iterations: `occupancy[index / 8] |= ...` is a
non-atomic read-modify-write, and two cells whose indices share a byte (any of the
8 consecutive-in-X cells packed together) being decided by different threads at the
same time would race and silently drop one thread's bit. Fixed by having each thread
write into a `bool[]` (one full byte per cell — safe for concurrent writes to
different elements), then bit-packing into the final `occupancy` byte array in a
single-threaded pass afterward.

Cancellation (`CancellationToken`) is passed via `ParallelOptions.CancellationToken`,
which throws `OperationCanceledException` unwrapped on a cancelled token — same
exception type the existing test (`VoxelizationServiceTests.cs:264`) already asserted
against the old sequential `cancellationToken.ThrowIfCancellationRequested()`.

## Benchmark

Throwaway benchmark (not committed): a single 12-triangle box mesh scaled to produce
an 88×88×88 grid (681,472 cells, `cellSize = 1`, under `MaxCells = 900_000`), timed
with `Stopwatch` after a JIT warm-up call, Release build.

Machine: `Environment.ProcessorCount = 10`.

| Version | Elapsed |
|---|---|
| Sequential (before) | 2903 ms |
| Parallel (`Parallel.For` over X) | 1336 ms |

**≈2.2× faster** on this case.

### Why not ~10x (core count)

- This mesh is a simple 12-triangle box, so most cells take the cheap path
  (`IsPointInsideViaGrid`: 3 ray casts through a small spatial grid) rather than the
  heavier SAT-vs-many-triangles path (`TriangleIntersectsBox` looping
  `TrianglesNear`). Less per-cell work means task-scheduling overhead eats a larger
  share of the theoretical gain.
- `CollectTriangles`, `TriangleSpatialGrid.Build`, and the final bit-packing pass stay
  single-threaded — per Amdahl's law, this floor caps the achievable speedup
  regardless of core count.

**Not yet measured**: a real imported STL with thousands of surface triangles (more
per-cell work in `IsCubeIncluded`, since `TrianglesNear` returns more candidates near
the surface) should show a larger speedup, closer to 4-6x — this is an estimate, not
a measured result.

## Verification

- `dotnet build Solvix.Voxelization` — clean, 0 warnings/errors.
- `dotnet test Solvix.Voxelization.Tests` — 20/20 passing, including the
  pre-cancelled-token test (still throws `OperationCanceledException` unwrapped).