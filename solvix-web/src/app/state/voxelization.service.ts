import { Injectable, effect, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { debounceTime, groupBy, mergeMap } from 'rxjs';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { MeshApiService, parseInvalidMeshError, parseVoxelizationTooLargeError } from '../api/mesh-api.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';
import { toMeshBinary } from '../geometry/mesh-contract';
import { buildVoxelPreview, disposeVoxelPreview, setVoxelEdgeOpacity, setVoxelPreviewOpacity } from '../geometry/voxel-preview';

const DEFAULT_VOXEL_OPACITY = 0.55;
const DEFAULT_VOXEL_EDGE_OPACITY = 1;

// How long to wait after the LAST reference rebuild (density change,
// rotation commit, reset) before auto-re-running voxelization - long
// enough that a quick sequence of edits (e.g. nudging density a few times)
// only triggers one network round-trip for the final value, short enough
// that the result reappears promptly once the user settles.
const AUTO_RERUN_DEBOUNCE_MS = 500;

export type VoxelizationStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; result: VoxelGridDto }
  | { kind: 'too-large'; cellCount: number; limit: number }
  | { kind: 'invalid-mesh'; message: string }
  | { kind: 'error' };

// Per-session voxelization request/result state. Deliberately does NOT
// track its own density/scale - ImportedReferenceRenderService already
// owns exactly that (the "Розмір (найдовша сторона)" control), and its
// scaled clone (getScaledReference) is built on the same "1 world unit = 1
// unit cube" convention Solvix.Voxelization's VoxelizationService uses (a
// fixed 1x1x1 cube - see MeshApiService/geometry/voxel-grid-contract.ts) -
// display and request always agree on what "1 unit" means because they're
// the SAME object, not two independently-scaled copies.
@Injectable({ providedIn: 'root' })
export class VoxelizationService {
  private readonly sessions = inject(SessionsService);
  private readonly referenceRender = inject(ImportedReferenceRenderService);
  private readonly meshApi = inject(MeshApiService);
  private readonly statusBySession = new KeyedStore<number, VoxelizationStatus>();
  // The rendered voxel-cube preview for the LAST successful run - kept
  // separate from statusBySession (rather than derived from it on every
  // read) for the same identity-cache reasoning as
  // ImportedReferenceRenderService.getScaledReference: WorldCanvasComponent
  // only rebuilds its own scene clone when the OBJECT IDENTITY it's handed
  // changes, so this must be built ONCE per successful result and cached,
  // not reconstructed on every getter call. Stays showing the last
  // successful result even if a LATER run fails - a failed retry shouldn't
  // blank out a preview that was actually valid.
  private readonly voxelPreviewBySession = new KeyedStore<number, THREE.Object3D>();
  // Which scaled-reference OBJECT IDENTITY the current status/preview were
  // actually computed from - lets getStatus/getVoxelPreview detect that the
  // reference has since been rebuilt (density change, rotate-gizmo drag,
  // new import all call ImportedReferenceRenderService.refreshScaledReference,
  // which swaps in a new object) and hide a now-out-of-sync result instead
  // of silently showing voxel cubes that no longer match the geometry's
  // current size/orientation.
  private readonly voxelizedReferenceBySession = new KeyedStore<number, THREE.Object3D>();
  // User-controlled transparency for the voxel-cube FILL. Kept even while
  // stale/hidden, so whatever the user last set is what the NEXT
  // successful run's preview starts at, rather than resetting.
  private readonly opacityBySession = new KeyedStore<number, number>();
  // Same, but for the white edge outline (wireframe) - a separate control
  // from the fill's opacity above, so the two can be tuned independently
  // (e.g. a near-invisible fill with a fully-opaque wireframe, or vice
  // versa).
  private readonly edgeOpacityBySession = new KeyedStore<number, number>();
  // Bumped on every run() call and captured by that call's own closure -
  // lets a response recognize it's no longer the LATEST request for this
  // session (superseded by a later run() before this one's HTTP call
  // returned) and discard itself instead of overwriting a fresher result.
  // Only matters once runs can fire without direct user action (see the
  // auto-rerun subscription below) - a manual click already couldn't
  // overlap with itself, but a debounced auto-run now can land while an
  // earlier request (manual or auto) is still in flight.
  private readonly runGenerationBySession = new KeyedStore<number, number>();

  constructor() {
    effect(() => {
      const ids = this.sessions.sessions().map(session => session.id);
      this.statusBySession.pruneTo(ids);
      this.voxelPreviewBySession.pruneTo(ids, preview => disposeVoxelPreview(preview));
      this.voxelizedReferenceBySession.pruneTo(ids);
      this.opacityBySession.pruneTo(ids);
      this.edgeOpacityBySession.pruneTo(ids);
      this.runGenerationBySession.pruneTo(ids);
    });

    // Auto-re-run instead of just leaving a stale result hidden (see
    // isStale) once the reference it was computed from is rebuilt -
    // grouped by session so one session's edits don't reset another's
    // debounce timer, and each group debounced independently so a quick
    // sequence of edits to the SAME session only fires one request, for
    // the final value.
    this.referenceRender.referenceChanged$
      .pipe(
        groupBy(sessionId => sessionId),
        mergeMap(group$ => group$.pipe(debounceTime(AUTO_RERUN_DEBOUNCE_MS)))
      )
      .subscribe(sessionId => this.run(sessionId));
  }

  getStatus(sessionId: number): VoxelizationStatus {
    if (this.isStale(sessionId)) {
      return { kind: 'idle' };
    }
    return this.statusBySession.get(sessionId) ?? { kind: 'idle' };
  }

  // Same identity-cache reasoning as ImportedReferenceRenderService.getScaledReference
  // - null until a run() has actually succeeded for this session, and null
  // again once the reference has moved on (see isStale).
  getVoxelPreview(sessionId: number): THREE.Object3D | null {
    return this.isStale(sessionId) ? null : this.voxelPreviewBySession.get(sessionId) ?? null;
  }

  getOpacity(sessionId: number): number {
    return this.opacityBySession.get(sessionId) ?? DEFAULT_VOXEL_OPACITY;
  }

  // Mutates the cached preview's fill material directly (cheap, no rebuild
  // - see setVoxelPreviewOpacity) so the slider responds live, even if the
  // preview is currently stale/hidden (isStale) - the change still takes
  // effect the moment it's un-hidden by a fresh run.
  setOpacity(sessionId: number, opacity: number): void {
    const clamped = Math.min(1, Math.max(0, opacity));
    this.opacityBySession.set(sessionId, clamped);
    const preview = this.voxelPreviewBySession.get(sessionId);
    if (preview) {
      setVoxelPreviewOpacity(preview, clamped);
    }
  }

  getEdgeOpacity(sessionId: number): number {
    return this.edgeOpacityBySession.get(sessionId) ?? DEFAULT_VOXEL_EDGE_OPACITY;
  }

  // Same live-mutation reasoning as setOpacity, for the edge outline.
  setEdgeOpacity(sessionId: number, opacity: number): void {
    const clamped = Math.min(1, Math.max(0, opacity));
    this.edgeOpacityBySession.set(sessionId, clamped);
    const preview = this.voxelPreviewBySession.get(sessionId);
    if (preview) {
      setVoxelEdgeOpacity(preview, clamped);
    }
  }

  // True once the reference this session last voxelized is no longer the
  // one ImportedReferenceRenderService is currently showing - e.g. the user
  // ran voxelization, then changed density or rotated the object, without
  // re-running. Doesn't eagerly dispose the stale entries (they're small
  // and get replaced/disposed on the next successful run, or on session
  // close via pruneTo) - just hides them.
  private isStale(sessionId: number): boolean {
    const voxelized = this.voxelizedReferenceBySession.get(sessionId);
    return voxelized !== undefined && this.referenceRender.getScaledReference(sessionId) !== voxelized;
  }

  // Sends the session's current scaled reference (ImportedReferenceRenderService)
  // to Solvix.Api and stores the outcome. Called both directly (the
  // "Вокселізувати" button) and automatically, debounced, whenever the
  // reference is rebuilt (see the constructor's referenceChanged$
  // subscription) - either way it's a real network request against
  // whatever's currently expensive about the mesh, so callers should
  // still avoid firing it in a tight loop themselves.
  run(sessionId: number): void {
    const scaledReference = this.referenceRender.getScaledReference(sessionId);
    if (!scaledReference) {
      return;
    }

    const generation = (this.runGenerationBySession.get(sessionId) ?? 0) + 1;
    this.runGenerationBySession.set(sessionId, generation);
    // True only for the response that arrives from THIS call - guards
    // against a superseded run (e.g. the debounced auto-run firing while
    // a manual click's request is still in flight) overwriting a result
    // that came from a LATER run() call for the same session.
    const isCurrentRun = () => this.runGenerationBySession.get(sessionId) === generation;

    this.voxelizedReferenceBySession.set(sessionId, scaledReference);
    this.statusBySession.set(sessionId, { kind: 'loading' });
    const mesh = toMeshBinary(scaledReference);

    this.meshApi.voxelize(mesh).subscribe({
      next: result => {
        if (!this.sessionExists(sessionId) || !isCurrentRun()) {
          return;
        }
        this.statusBySession.set(sessionId, { kind: 'ok', result });
        // Does NOT dispose the outgoing preview here, even though it's
        // about to be replaced - see ImportedReferenceRenderService's
        // refreshScaledReference for why (the same race applies to any
        // overlay whose geometry/material WorldCanvasComponent's clone
        // shares by reference). WorldCanvasComponent disposes the old
        // clone itself, at the moment it actually removes it from the
        // scene. Only pruneTo's session-close cleanup (in the constructor)
        // still disposes eagerly, since a closed session's preview may
        // never be swapped out by any WorldCanvasComponent at all.
        this.voxelPreviewBySession.set(sessionId, buildVoxelPreview(result, this.getOpacity(sessionId), this.getEdgeOpacity(sessionId)));
      },
      error: (response: HttpErrorResponse) => {
        if (!this.sessionExists(sessionId) || !isCurrentRun()) {
          return;
        }
        const tooLarge = parseVoxelizationTooLargeError(response);
        if (tooLarge) {
          this.statusBySession.set(sessionId, { kind: 'too-large', ...tooLarge });
          return;
        }
        const invalidMesh = parseInvalidMeshError(response);
        this.statusBySession.set(sessionId, invalidMesh ? { kind: 'invalid-mesh', ...invalidMesh } : { kind: 'error' });
      }
    });
  }

  private sessionExists(sessionId: number): boolean {
    return this.sessions.sessions().some(session => session.id === sessionId);
  }
}