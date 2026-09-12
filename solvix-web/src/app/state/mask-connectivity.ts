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
