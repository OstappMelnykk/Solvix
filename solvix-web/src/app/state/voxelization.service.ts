import { Injectable, effect, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import * as THREE from 'three';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { MeshApiService, parseInvalidMeshError, parseVoxelizationTooLargeError } from '../api/mesh-api.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';
import { toMeshBinary } from '../geometry/mesh-contract';
import {
  buildVoxelPreview,
  disposeVoxelPreview,
  setVoxelEdgeOpacity,
  setVoxelNodeOpacity,
  setVoxelNodeSize,
  setVoxelPreviewOpacity
} from '../geometry/voxel-preview';

const DEFAULT_VOXEL_OPACITY = 0.55;
const DEFAULT_VOXEL_EDGE_OPACITY = 1;
const DEFAULT_VOXEL_NODE_SIZE = 0.5;
const DEFAULT_VOXEL_NODE_OPACITY = 1;

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
  // User-controlled transparency for the voxel-cube FILL. Kept even while
  // stale/hidden, so whatever the user last set is what the NEXT
  // successful run's preview starts at, rather than resetting.
  private readonly opacityBySession = new KeyedStore<number, number>();
  // Same, but for the white edge outline (wireframe) - a separate control
  // from the fill's opacity above, so the two can be tuned independently
  // (e.g. a near-invisible fill with a fully-opaque wireframe, or vice
  // versa).
  private readonly edgeOpacityBySession = new KeyedStore<number, number>();
  // Radius of the node spheres, relative to cellSize (see
  // voxel-preview.ts's NODE_RADIUS_MAX_FACTOR) - same [0,1] slider
  // convention as the opacity controls above, independent of them.
  private readonly nodeSizeBySession = new KeyedStore<number, number>();
  // Same, but for the node spheres' opacity - independent of the fill and
  // edge opacity above, same reasoning (a near-invisible fill/wireframe
  // with fully-opaque nodes highlighting just the mesh's unique vertices,
  // or vice versa).
  private readonly nodeOpacityBySession = new KeyedStore<number, number>();
  // Bumped on every run() call and captured by that call's own closure -
  // lets a response recognize it's no longer the LATEST request for this
  // session (superseded by a later run() before this one's HTTP call
  // returned) and discard itself instead of overwriting a fresher result.
  // Guards against a slow request finishing after a newer manual click's
  // request already landed - voxelization only ever runs on an explicit
  // "Вокселізувати" click, never automatically, but a user can still click
  // it again before the first response arrives.
  private readonly runGenerationBySession = new KeyedStore<number, number>();

  constructor() {
    effect(() => {
      const ids = this.sessions.sessions().map(session => session.id);
      this.statusBySession.pruneTo(ids);
      this.voxelPreviewBySession.pruneTo(ids, preview => disposeVoxelPreview(preview));
      this.opacityBySession.pruneTo(ids);
      this.edgeOpacityBySession.pruneTo(ids);
      this.nodeSizeBySession.pruneTo(ids);
      this.nodeOpacityBySession.pruneTo(ids);
      this.runGenerationBySession.pruneTo(ids);
    });

    // Actively clears (not just hides) a session's result the moment the
    // geometry it was computed from is gone - density change, rotate-gizmo
    // drag, reset, new import (ImportedReferenceRenderService.refreshScaledReference)
    // all emit here. Never re-runs on its own - voxelization only ever
    // starts from the explicit "Вокселізувати" click (see run()).
    this.referenceRender.referenceChanged$.subscribe(sessionId => this.clearResult(sessionId));
  }

  getStatus(sessionId: number): VoxelizationStatus {
    return this.statusBySession.get(sessionId) ?? { kind: 'idle' };
  }

  // Same identity-cache reasoning as ImportedReferenceRenderService.getScaledReference
  // - null until a run() has actually succeeded for this session, and null
  // again once clearResult drops it (see referenceChanged$ above).
  getVoxelPreview(sessionId: number): THREE.Object3D | null {
    return this.voxelPreviewBySession.get(sessionId) ?? null;
  }

  getOpacity(sessionId: number): number {
    return this.opacityBySession.get(sessionId) ?? DEFAULT_VOXEL_OPACITY;
  }

  // Mutates the cached preview's fill material directly (cheap, no rebuild
  // - see setVoxelPreviewOpacity), so the slider responds live to whatever
  // preview currently exists.
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

  getNodeSize(sessionId: number): number {
    return this.nodeSizeBySession.get(sessionId) ?? DEFAULT_VOXEL_NODE_SIZE;
  }

  // Same live-mutation reasoning as setOpacity, for the node spheres' size
  // (setVoxelNodeSize swaps their shared SphereGeometry in place - cheap,
  // one geometry regardless of node count).
  setNodeSize(sessionId: number, size: number): void {
    const clamped = Math.min(1, Math.max(0, size));
    this.nodeSizeBySession.set(sessionId, clamped);
    const preview = this.voxelPreviewBySession.get(sessionId);
    if (preview) {
      setVoxelNodeSize(preview, clamped);
    }
  }

  getNodeOpacity(sessionId: number): number {
    return this.nodeOpacityBySession.get(sessionId) ?? DEFAULT_VOXEL_NODE_OPACITY;
  }

  // Same live-mutation reasoning as setOpacity, for the node spheres.
  setNodeOpacity(sessionId: number, opacity: number): void {
    const clamped = Math.min(1, Math.max(0, opacity));
    this.nodeOpacityBySession.set(sessionId, clamped);
    const preview = this.voxelPreviewBySession.get(sessionId);
    if (preview) {
      setVoxelNodeOpacity(preview, clamped);
    }
  }

  // Drops a session's result the moment its geometry changes underneath it
  // (see the referenceChanged$ subscription above) - back to idle, no
  // preview, so the old cubes never linger next to (or inside) geometry
  // they no longer match. Also bumps runGenerationBySession so a request
  // already in flight for the OLD geometry gets discarded on arrival
  // (isCurrentRun in run()) instead of resurrecting a result for geometry
  // that no longer exists.
  private clearResult(sessionId: number): void {
    this.runGenerationBySession.set(sessionId, (this.runGenerationBySession.get(sessionId) ?? 0) + 1);
    this.statusBySession.set(sessionId, { kind: 'idle' });
    const preview = this.voxelPreviewBySession.get(sessionId);
    if (preview) {
      disposeVoxelPreview(preview);
      this.voxelPreviewBySession.delete(sessionId);
    }
  }

  // Sends the session's current scaled reference (ImportedReferenceRenderService)
  // to Solvix.Api and stores the outcome. Only ever called directly (the
  // "Вокселізувати" button) - never automatically - but it's still a real
  // network request against whatever's currently expensive about the
  // mesh, so callers should avoid firing it in a tight loop themselves.
  run(sessionId: number): void {
    const scaledReference = this.referenceRender.getScaledReference(sessionId);
    if (!scaledReference) {
      return;
    }

    const generation = (this.runGenerationBySession.get(sessionId) ?? 0) + 1;
    this.runGenerationBySession.set(sessionId, generation);
    // True only for the response that arrives from THIS call - guards
    // against a superseded run (a second manual click before the first
    // resolves, or clearResult bumping the generation because the
    // geometry changed mid-request) overwriting a result that came from a
    // LATER run() call, or resurrecting one for geometry that's already
    // gone, for the same session.
    const isCurrentRun = () => this.runGenerationBySession.get(sessionId) === generation;

    this.statusBySession.set(sessionId, { kind: 'loading' });
    const mesh = toMeshBinary(scaledReference);

    this.meshApi.voxelize(mesh).subscribe({
      next: result => {
        if (!this.sessionExists(sessionId) || !isCurrentRun()) {
          return;
        }
        this.statusBySession.set(sessionId, { kind: 'ok', result });
        // DOES dispose the outgoing preview here, unlike the OLD
        // InstancedMesh-based preview (which left this to
        // WorldCanvasComponent, since its clone() shared geometry by
        // reference with the source anyway - disposing either one broke
        // both). BatchedMesh (see geometry/voxel-preview.ts) can't be
        // cloned per canvas at all, so voxelPreview has exactly one real
        // owner now - this service's cache - and exactly one consumer
        // (Ideal World only, see render-window.component.ts). Whichever
        // object this service is no longer caching is safe to dispose
        // immediately: WorldCanvasComponent's updateVoxelPreview runs
        // synchronously right before every renderer.render() call, so by
        // the time a frame actually renders, the single consumer has
        // already swapped to whatever this method set here.
        const outgoing = this.voxelPreviewBySession.get(sessionId);
        this.voxelPreviewBySession.set(
          sessionId,
          buildVoxelPreview(result, this.getOpacity(sessionId), this.getEdgeOpacity(sessionId), this.getNodeSize(sessionId), this.getNodeOpacity(sessionId))
        );
        if (outgoing) {
          disposeVoxelPreview(outgoing);
        }
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