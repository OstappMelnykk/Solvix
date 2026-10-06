import { Injectable, effect, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { KeyedStore } from './keyed-store';
import { SessionsService } from './sessions.service';
import { NotificationService } from './notification.service';
import { MeshEditorSelectionService } from './mesh-editor-selection.service';
import {
  HexFaceName,
  MeshCommandResultDto,
  MeshEditorApiService,
  MeshMappingResultDto,
  MeshPointDto,
  MeshStateDto
} from '../api/mesh-editor-api.service';

// The client-side mirror of each session's mesh. The backend owns every
// geometric decision; this only caches the latest state it sent and
// forwards the user's commands. A refused command (ok: false) still
// carries the unchanged state, so the view is always in sync with the
// server, and its reason is surfaced as a toast.
//
// Root-scoped and keyed by sessionId like the other per-session services -
// the 3 World canvases are shared across sessions.
@Injectable({ providedIn: 'root' })
export class MeshEditorService {
  private readonly api = inject(MeshEditorApiService);
  private readonly sessions = inject(SessionsService);
  private readonly notifications = inject(NotificationService);
  private readonly selection = inject(MeshEditorSelectionService);
  private readonly stateBySession = new KeyedStore<number, MeshStateDto>();
  private readonly requested = new Set<number>();

  // True while a command is in flight - the controls disable themselves so a
  // double click cannot send the same command twice.
  readonly busy = signal(false);

  // Whether dragging a corner node also carries the midpoints of its edges
  // (they move by half, so the edges stay as curved as they were). Shared by
  // the numeric fields and the on-canvas drag gizmo.
  carryEdgeMidpoints = true;

  constructor() {
    effect(
      () => {
        const ids = this.sessions.sessions().map(session => session.id);
        this.stateBySession.pruneTo(ids);
        for (const id of [...this.requested]) {
          if (!ids.includes(id)) this.requested.delete(id);
        }
        const active = this.sessions.activeSessionId();
        if (active !== null && !this.requested.has(active)) {
          this.requested.add(active);
          this.refresh(active);
        }
      },
      { allowSignalWrites: true }
    );
  }

  getState(sessionId: number): MeshStateDto | null {
    return this.stateBySession.get(sessionId) ?? null;
  }

  refresh(sessionId: number): void {
    this.api.getState(sessionId).subscribe({
      next: state => this.accept(sessionId, state),
      error: () => {
        // Allow a retry the next time this session becomes active.
        this.requested.delete(sessionId);
        this.notifications.error('Не вдалось отримати стан сітки з сервера.');
      }
    });
  }

  addFirstHex(sessionId: number): void {
    this.run(sessionId, this.api.addFirstHex(sessionId));
  }

  addHexOnFace(sessionId: number, hexId: number, face: HexFaceName): void {
    this.run(sessionId, this.api.addHexOnFace(sessionId, hexId, face));
  }

  linkFaces(sessionId: number, hexA: number, faceA: HexFaceName, hexB: number, faceB: HexFaceName, adaptSecond: boolean): void {
    this.run(sessionId, this.api.linkFaces(sessionId, hexA, faceA, hexB, faceB, adaptSecond));
  }

  linkHexes(sessionId: number, hexA: number, hexB: number, adaptSecond: boolean): void {
    this.run(sessionId, this.api.linkHexes(sessionId, hexA, hexB, adaptSecond));
  }

  unlinkFace(sessionId: number, hexId: number, face: HexFaceName): void {
    this.run(sessionId, this.api.unlinkFace(sessionId, hexId, face));
  }

  moveNode(sessionId: number, nodeId: number, position: MeshPointDto, carryEdgeMidpoints: boolean): void {
    this.run(sessionId, this.api.moveNode(sessionId, nodeId, position, carryEdgeMidpoints));
  }

  undo(sessionId: number): void {
    this.run(sessionId, this.api.undo(sessionId));
  }

  redo(sessionId: number): void {
    this.run(sessionId, this.api.redo(sessionId));
  }

  reset(sessionId: number): void {
    this.run(sessionId, this.api.reset(sessionId));
  }

  mapIdealToReal(sessionId: number, ideal: MeshPointDto): Observable<MeshMappingResultDto> {
    return this.api.mapIdealToReal(sessionId, ideal);
  }

  mapRealToIdeal(sessionId: number, real: MeshPointDto): Observable<MeshMappingResultDto> {
    return this.api.mapRealToIdeal(sessionId, real);
  }

  private accept(sessionId: number, state: MeshStateDto): void {
    this.stateBySession.set(sessionId, state);
    const hexes = new Set(state.hexes.map(h => h.id));
    const nodes = new Set(state.nodes.map(n => n.id));
    this.selection.retain(sessionId, id => hexes.has(id), id => nodes.has(id));
  }

  private run(sessionId: number, request: Observable<MeshCommandResultDto>): void {
    this.busy.set(true);
    request.subscribe({
      next: result => {
        this.accept(sessionId, result.state);
        if (!result.ok && result.error) this.notifications.warning(result.error);
        this.busy.set(false);
      },
      error: () => {
        this.notifications.error('Не вдалось виконати команду: сервер недоступний.');
        this.busy.set(false);
      }
    });
  }
}
