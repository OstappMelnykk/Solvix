// Shared by ZonePaintingService (voxel zones) and SurfaceZonePaintingService
// (STL surface zones) - both paint a 2D selection mask per axis and reject
// an edit that would leave it split into 2+ disconnected pieces. Extracted
// here (rather than duplicated) so the one connectivity rule both tools
// enforce can never quietly drift apart between the two.

// 4-connectivity flood fill - is every SET cell in `mask` reachable from
// every other SET cell? An empty mask counts as connected (nothing to
// disconnect yet), matching how "no selection" isn't itself a violation of
// GEOMETRY_RULES.md-style connectivity rules elsewhere in this codebase.
export function isSingleConnectedComponent(mask: Uint8Array, width: number, height: number): boolean {
  const start = mask.indexOf(1);
  if (start === -1) {
    return true;
  }
  const visited = new Uint8Array(mask.length);
  visited[start] = 1;
  let visitedCount = 1;
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      total++;
    }
  }
  const stack = [start];
  while (stack.length > 0) {
    const index = stack.pop()!;
    const u = index % width;
    const v = (index / width) | 0;
    const neighbors: [number, number][] = [
      [u + 1, v],
      [u - 1, v],
      [u, v + 1],
      [u, v - 1]
    ];
    for (const [nu, nv] of neighbors) {
      if (nu < 0 || nu >= width || nv < 0 || nv >= height) {
        continue;
      }
      const nIndex = nu + nv * width;
      if (mask[nIndex] && !visited[nIndex]) {
        visited[nIndex] = 1;
        visitedCount++;
        stack.push(nIndex);
      }
    }
  }
  return visitedCount === total;
}

// 4-connectivity flood fill, but labels EVERY set cell with which piece it
// belongs to (0, 1, 2, ...) instead of just answering yes/no - lets a
// caller draw each disconnected "island" in a visually distinct way (a
// direct hint on the geometry itself for what isSingleConnectedComponent
// would otherwise only report as a single true/false), so the user can see
// AT A GLANCE which cells still need to be bridged together, not just read
// a text error after the fact. -1 for an unset cell. A single connected
// mask labels everything 0 - callers that only care about "how many
// islands" can just check the returned count.
export function labelConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number
): { readonly labels: Int32Array; readonly componentCount: number } {
  const labels = new Int32Array(mask.length).fill(-1);
  let componentCount = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) {
      continue;
    }
    const label = componentCount++;
    labels[start] = label;
    const stack = [start];
    while (stack.length > 0) {
      const index = stack.pop()!;
      const u = index % width;
      const v = (index / width) | 0;
      const neighbors: [number, number][] = [
        [u + 1, v],
        [u - 1, v],
        [u, v + 1],
        [u, v - 1]
      ];
      for (const [nu, nv] of neighbors) {
        if (nu < 0 || nu >= width || nv < 0 || nv >= height) {
          continue;
        }
        const nIndex = nu + nv * width;
        if (mask[nIndex] && labels[nIndex] === -1) {
          labels[nIndex] = label;
          stack.push(nIndex);
        }
      }
    }
  }
  return { labels, componentCount };
}
