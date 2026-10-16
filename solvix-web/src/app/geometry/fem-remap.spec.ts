import { SolverMeshDto } from '../api/solver-api.service';
import { localCoordsOfKey, remapMesh } from './fem-remap';
import { singleCubeState } from './mesh-state.fixture.spec';

// the lower half of the cube along x: corners at fractions 0 and 1/2 of the cube
const HALF_X = '0|2|0,0,0;1,0,0;0,2,0;1,2,0;0,0,2;1,0,2;0,2,2;1,2,2';

describe('where the elements of a refined mesh stand', () => {
  it('reads the place of the 20 nodes of an element in its cube from its key', () => {
    const local = localCoordsOfKey(HALF_X)!;
    expect(local.length).toBe(60);
    // corner 0 is (-1,-1,-1); corner 1 (slot 1) is half way along x: (0,-1,-1); the midpoint of the edge between them (slot 8) is (-0.5,-1,-1)
    expect(local.slice(0, 3)).toEqual([-1, -1, -1]);
    expect(local.slice(3, 6)).toEqual([0, -1, -1]);
    expect(local.slice(24, 27)).toEqual([-0.5, -1, -1]);
  });

  it('does not read a key of an even division', () => {
    expect(localCoordsOfKey('3:0,1,2')).toBeNull();
    expect(localCoordsOfKey('x|0|bad')).toBeNull();
  });

  it('puts the nodes through the cube\'s own map in the world asked for', () => {
    const state = singleCubeState();
    const mesh = { positions: new Array(60).fill(0), connectivity: Array.from({ length: 20 }, (_, i) => i), hexIds: [state.hexes[0].id], keys: [HALF_X] } as unknown as SolverMeshDto;
    const real = remapMesh(mesh, state, 'real');
    const cubeNodes = state.hexes[0].nodeIds.map(id => state.nodes.find(n => n.id === id)!);
    // node 1 is the corner half way along x: its x lies between the cube's two x extremes
    const xs = cubeNodes.map(n => n.x);
    expect(real.positions[3]).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 6);
    const ideal = remapMesh(mesh, state, 'ideal');
    expect(ideal.positions[3]).toBeCloseTo((Math.min(...cubeNodes.map(n => n.idealX)) + Math.max(...cubeNodes.map(n => n.idealX))) / 4, 6);
  });

  it('keeps the positions of an element it cannot read', () => {
    const state = singleCubeState();
    const mesh = { positions: [1, 2, 3], connectivity: new Array(20).fill(0), hexIds: [state.hexes[0].id], keys: ['3:0,1,2'] } as unknown as SolverMeshDto;
    expect(remapMesh(mesh, state, 'real').positions).toEqual([1, 2, 3]);
  });
});
