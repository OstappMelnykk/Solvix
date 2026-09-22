import { TestBed } from '@angular/core/testing';
import { VoxelizationStorageService, VoxelizationRenderSettings } from './voxelization-storage.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';

const RENDER: VoxelizationRenderSettings = { opacity: 0.5, edgeOpacity: 1, lineWidth: 0.25, nodeSize: 0.5, nodeOpacity: 1 };

function grid(occupancy: number[], markedForRefinement: number[]): VoxelGridDto {
  return {
    origin: { x: 0, y: 0, z: 0 },
    cellSize: 1,
    countX: occupancy.length * 8,
    countY: 1,
    countZ: 1,
    occupancy: new Uint8Array(occupancy),
    markedForRefinement: new Uint8Array(markedForRefinement)
  };
}

describe('VoxelizationStorageService', () => {
  let service: VoxelizationStorageService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(VoxelizationStorageService);
  });

  it('round-trips occupancy and markedForRefinement through save/load', () => {
    service.save(1, grid([0b11], [0b10]), RENDER);

    const loaded = service.load(1);

    expect(Array.from(loaded!.grid.occupancy)).toEqual([0b11]);
    expect(Array.from(loaded!.grid.markedForRefinement)).toEqual([0b10]);
  });

  // Regression: a session saved before markedForRefinement existed has no
  // such key in its stored JSON at all (not an empty array - genuinely
  // absent), which used to throw "undefined is not iterable" out of
  // Uint8Array.from(undefined) on every reload instead of loading.
  it('does not throw when loading a pre-existing session saved without markedForRefinement', () => {
    localStorage.setItem(
      'solvix:voxelization:1',
      JSON.stringify({
        grid: { origin: { x: 0, y: 0, z: 0 }, cellSize: 1, countX: 8, countY: 1, countZ: 1, occupancy: [0b11] },
        render: RENDER
      })
    );

    let loaded: ReturnType<VoxelizationStorageService['load']>;
    expect(() => (loaded = service.load(1))).not.toThrow();
    expect(Array.from(loaded!.grid.occupancy)).toEqual([0b11]);
    expect(Array.from(loaded!.grid.markedForRefinement)).toEqual([0]);
  });

  it('returns null for a session that was never saved', () => {
    expect(service.load(999)).toBeNull();
  });
});
