import { Injectable } from '@angular/core';
import { readJson, removeKey, writeJson } from './local-storage-json';

const STORAGE_KEY_PREFIX = 'solvix:surface-zone-painting:';

// Plain-data mirror of SurfaceZonePaintingService's own private
// SurfacePaintingSession - see zone-painting-storage.service.ts's own header
// comment for the general reasoning (TypedArrays -> plain number[] for JSON,
// pending/uncommitted masks included too).
//
// Deliberately does NOT store the shell grid itself (VoxelGridDto), nor the
// solid voxelGrid it was built from - unlike ZonePaintingService's grid
// (which comes from VoxelizationService, independently restorable),
// SurfaceZonePaintingService's shell grid can only be REBUILT via
// buildSurfaceShellGrid(stlMesh, voxelGrid, subdivisions), which needs the
// live STL mesh object. That object is only ever available inside this
// service's own open() call (handed a fresh SurfaceZonePaintingSource by the
// component) - so restoration happens there too, splicing this persisted
// data onto whatever grid open() just built, rather than at construction
// time. `subdivisions` and `cellCount` (the shell grid's own total cell
// count) are the sanity signature open() checks before trusting a restore -
// a mismatch (different subdivisions, or somehow a different-shaped grid)
// means this data was painted against a shell grid shape that no longer
// exists, so it's discarded instead of spliced onto the wrong array indices.
export interface PersistedSurfacePaintingSession {
  readonly subdivisions: number;
  readonly cellCount: number;
  readonly assignedCount: number;
  readonly usedVoxelZoneIds: number[];
  readonly activeVoxelZoneId: number;
  readonly cellZone: number[];
  readonly triangleZone: number[] | null;
  readonly maskX: number[];
  readonly maskY: number[];
  readonly maskZ: number[];
}

@Injectable({ providedIn: 'root' })
export class SurfaceZonePaintingStorageService {
  save(sessionId: number, data: PersistedSurfacePaintingSession): void {
    writeJson(STORAGE_KEY_PREFIX + sessionId, data);
  }

  load(sessionId: number): PersistedSurfacePaintingSession | null {
    return readJson<PersistedSurfacePaintingSession>(STORAGE_KEY_PREFIX + sessionId);
  }

  delete(sessionId: number): void {
    removeKey(STORAGE_KEY_PREFIX + sessionId);
  }
}
