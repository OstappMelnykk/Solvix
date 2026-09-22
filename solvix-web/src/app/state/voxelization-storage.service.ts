import { Injectable } from '@angular/core';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';
import { readJson, removeKey, writeJson } from './local-storage-json';

const STORAGE_KEY_PREFIX = 'solvix:voxelization:';

interface PersistedVoxelGrid {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly cellSize: number;
  readonly countX: number;
  readonly countY: number;
  readonly countZ: number;
  // Plain number[], NOT a Uint8Array directly - JSON has no TypedArray
  // representation of its own, so this is converted explicitly on both
  // ends (Array.from/Uint8Array.from) rather than relying on whatever a
  // given JS engine's JSON.stringify happens to do with a TypedArray as-is.
  readonly occupancy: number[];
  // Same conversion reasoning as occupancy.
  readonly markedForRefinement: number[];
}

export interface VoxelizationRenderSettings {
  readonly opacity: number;
  readonly edgeOpacity: number;
  readonly lineWidth: number;
  readonly nodeSize: number;
  readonly nodeOpacity: number;
}

interface PersistedVoxelization {
  readonly grid: PersistedVoxelGrid;
  readonly render: VoxelizationRenderSettings;
}

// Same reload-survival reasoning as ModelStorageService - see its own header
// comment. Only ever saves a genuinely successful result (VoxelizationService
// itself decides when that's worth calling save() vs delete()) - 'loading'/
// 'error'/'too-large'/'invalid-mesh' are transient request states with
// nothing worth resurrecting, and VoxelizationService.getStatus() already
// defaults to 'idle' for a session storage has nothing for. The rendered
// preview mesh itself is NOT persisted here (matches ModelStorageService's
// own "plain data only" principle) - it's cheap to rebuild from the grid via
// the exact same buildVoxelPreview() call applyEditedGrid already uses.
@Injectable({ providedIn: 'root' })
export class VoxelizationStorageService {
  save(sessionId: number, grid: VoxelGridDto, render: VoxelizationRenderSettings): void {
    const persisted: PersistedVoxelization = {
      grid: { ...grid, occupancy: Array.from(grid.occupancy), markedForRefinement: Array.from(grid.markedForRefinement) },
      render
    };
    writeJson(STORAGE_KEY_PREFIX + sessionId, persisted);
  }

  load(sessionId: number): { readonly grid: VoxelGridDto; readonly render: VoxelizationRenderSettings } | null {
    const persisted = readJson<PersistedVoxelization>(STORAGE_KEY_PREFIX + sessionId);
    if (!persisted) {
      return null;
    }
    return {
      grid: {
        ...persisted.grid,
        occupancy: Uint8Array.from(persisted.grid.occupancy),
        markedForRefinement: Uint8Array.from(persisted.grid.markedForRefinement)
      },
      render: persisted.render
    };
  }

  delete(sessionId: number): void {
    removeKey(STORAGE_KEY_PREFIX + sessionId);
  }
}
