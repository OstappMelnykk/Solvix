import { Injectable } from '@angular/core';
import { readJson, removeKey, writeJson } from './local-storage-json';

const STORAGE_KEY_PREFIX = 'solvix:zone-painting:';

export interface PersistedZoneDefinition {
  readonly id: number;
  readonly color: string;
  readonly voxelCount: number;
}

// Plain-data mirror of ZonePaintingService's own private PaintingSession -
// see ModelStorageService's own header comment for the general reload-
// survival reasoning. TypedArrays (voxelZone/maskX/Y/Z) are converted to
// plain number[] on the way in/out - JSON has no TypedArray representation
// of its own (same reasoning as VoxelizationStorageService's own occupancy
// field). Pending (uncommitted) masks are deliberately included too, not
// just committed zones - losing an in-progress, not-yet-"Завершити зону"
// selection to a reload would be exactly the same kind of silent data loss
// this whole persistence chain exists to prevent.
//
// Deliberately does NOT store the grid itself (VoxelGridDto) - the actual
// grid a restored session should use is whatever VoxelizationService itself
// restores for that session (the SAME object reference, not a separately
// re-deserialized copy), since ZonePaintingService.open()'s own cache check
// compares grids by REFERENCE (`existing.grid !== status.result`) - storing
// (and restoring) an independent copy here would make that check always
// fail and silently discard the very data being restored on the very next
// open(). `gridCellCount` is only a lightweight sanity signature, to refuse
// restoring onto a voxelization result that clearly isn't the same one this
// was painted against (e.g. VoxelizationService itself failed to restore).
export interface PersistedPaintingSession {
  readonly gridCellCount: number;
  readonly totalOccupied: number;
  readonly zones: PersistedZoneDefinition[];
  readonly zonesRevision: number;
  readonly opacity: number;
  readonly voxelZone: number[];
  readonly maskX: number[];
  readonly maskY: number[];
  readonly maskZ: number[];
}

@Injectable({ providedIn: 'root' })
export class ZonePaintingStorageService {
  save(sessionId: number, data: PersistedPaintingSession): void {
    writeJson(STORAGE_KEY_PREFIX + sessionId, data);
  }

  load(sessionId: number): PersistedPaintingSession | null {
    return readJson<PersistedPaintingSession>(STORAGE_KEY_PREFIX + sessionId);
  }

  delete(sessionId: number): void {
    removeKey(STORAGE_KEY_PREFIX + sessionId);
  }
}
