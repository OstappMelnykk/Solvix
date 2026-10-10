import { Injectable, effect, inject, signal } from '@angular/core';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';

interface Attachments {
  nodes: Set<number>;
  revision: number;
}

// The nodes of a session's mesh that are stuck to the imported surface (the STL reference): a stuck node slides along
// the surface when it is dragged - two degrees of freedom instead of three - until it is detached. Client-side
// state, like the selection: the server only ever gets the node's position.
@Injectable({ providedIn: 'root' })
export class SurfaceAttachmentService {
  private readonly sessions = inject(SessionsService);
  private readonly stores = new KeyedStore<number, Attachments>();

  // How close to the surface a dragged node has to come to stick to it, as a share of the surface's size. Small by
  // default (a node that only passes by does not stick); the user can change it. The same for every session.
  static readonly DEFAULT_SHARE = 0.01;
  static readonly MIN_SHARE = 0.001;
  static readonly MAX_SHARE = 0.05;
  private readonly _share = signal(SurfaceAttachmentService.DEFAULT_SHARE);
  readonly snapShare = this._share.asReadonly();

  // Whether a dragged node sticks to the surface at all.
  private readonly _enabled = signal(true);
  readonly snapEnabled = this._enabled.asReadonly();

  setSnapEnabled(on: boolean): void {
    this._enabled.set(on);
  }

  setSnapShare(share: number): void {
    if (!Number.isFinite(share)) return;
    this._share.set(Math.min(SurfaceAttachmentService.MAX_SHARE, Math.max(SurfaceAttachmentService.MIN_SHARE, share)));
  }

  constructor() {
    effect(() => this.stores.pruneTo(this.sessions.sessions().map(session => session.id)));
  }

  attached(sessionId: number): ReadonlySet<number> {
    return this.store(sessionId).nodes;
  }

  isAttached(sessionId: number, nodeId: number): boolean {
    return this.store(sessionId).nodes.has(nodeId);
  }

  // Changes when the set does: the view of the mesh is rebuilt on it.
  revision(sessionId: number): number {
    return this.store(sessionId).revision;
  }

  count(sessionId: number): number {
    return this.store(sessionId).nodes.size;
  }

  attach(sessionId: number, nodeId: number): void {
    const store = this.store(sessionId);
    if (store.nodes.has(nodeId)) return;
    store.nodes.add(nodeId);
    store.revision++;
  }

  detach(sessionId: number, nodeId: number): void {
    const store = this.store(sessionId);
    if (store.nodes.delete(nodeId)) store.revision++;
  }

  detachAll(sessionId: number): void {
    const store = this.store(sessionId);
    if (store.nodes.size === 0) return;
    store.nodes.clear();
    store.revision++;
  }

  // Forgets the nodes that are no longer in the mesh (removed cubes, a reset).
  retain(sessionId: number, hasNode: (nodeId: number) => boolean): void {
    const store = this.store(sessionId);
    let changed = false;
    for (const id of [...store.nodes]) {
      if (!hasNode(id)) {
        store.nodes.delete(id);
        changed = true;
      }
    }
    if (changed) store.revision++;
  }

  private store(sessionId: number): Attachments {
    return this.stores.getOrCreate(sessionId, () => ({ nodes: new Set<number>(), revision: 0 }));
  }
}
