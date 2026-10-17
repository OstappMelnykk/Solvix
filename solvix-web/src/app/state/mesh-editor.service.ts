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
  MeshShapeDto,
  MeshStateDto,
  MeshTemplateRequestDto
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
  // Every session id this service has seen open - to notice when one disappears.
  private readonly seen = new Set<number>();

  // True while a command is in flight - the controls disable themselves so a
  // double click cannot send the same command twice.
  readonly busy = signal(false);

  // Whether dragging a corner node also carries the midpoints of its edges (they
  // move by half, so the edges stay as straight as they were). OFF by default: the
  // 20 nodes of a cube are independent control points, as in the solver project's
  // viewer - dragging one changes only that node, and every other point of the
  // cube follows through the shape functions. Shared by the numeric fields, the
  // on-canvas gizmo and the six-view drag.
  carryEdgeMidpoints = false;

  constructor() {
    effect(
      () => {
        const ids = this.sessions.sessions().map(session => session.id);
        this.stateBySession.pruneTo(ids);
        for (const id of [...this.requested]) {
          if (!ids.includes(id)) this.requested.delete(id);
        }
        // A session that was open and now is not is gone for good (closed or
        // restarted): free its mesh on the server too. Best effort - a failure only
        // leaves some memory there until the server restarts.
        for (const id of [...this.seen]) {
          if (!ids.includes(id)) {
            this.seen.delete(id);
            this.api.dropSession(id).subscribe({ error: () => undefined });
          }
        }
        ids.forEach(id => this.seen.add(id));
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

  addFirstHex(sessionId: number, shape?: MeshShapeDto, cell?: { i: number; j: number; k: number }): void {
    this.run(sessionId, this.api.addFirstHex(sessionId, shape, cell));
  }

  // `then` runs after the new state has arrived (a body with layers gets its materials from it).
  addTemplate(sessionId: number, request: MeshTemplateRequestDto, then?: () => void): void {
    this.run(sessionId, this.api.addTemplate(sessionId, request), then);
  }

  addHexOnFace(sessionId: number, hexId: number, face: HexFaceName, shape?: MeshShapeDto): void {
    this.run(sessionId, this.api.addHexOnFace(sessionId, hexId, face, shape));
  }

  linkFaces(sessionId: number, hexA: number, faceA: HexFaceName, hexB: number, faceB: HexFaceName, adaptSecond: boolean): void {
    this.run(sessionId, this.api.linkFaces(sessionId, hexA, faceA, hexB, faceB, adaptSecond));
  }

  // The server refuses (and says why) when the body would fall apart.
  removeHex(sessionId: number, hexId: number): void {
    this.run(sessionId, this.api.removeHex(sessionId, hexId));
  }

  linkHexes(sessionId: number, hexA: number, hexB: number, adaptSecond: boolean): void {
    this.run(sessionId, this.api.linkHexes(sessionId, hexA, hexB, adaptSecond));
  }

  unlinkFace(sessionId: number, hexId: number, face: HexFaceName): void {
    this.run(sessionId, this.api.unlinkFace(sessionId, hexId, face));
  }

  moveNode(sessionId: number, nodeId: number, position: MeshPointDto, carryEdgeMidpoints: boolean, then?: () => void): void {
    this.run(sessionId, this.api.moveNode(sessionId, nodeId, position, carryEdgeMidpoints), then);
  }

  // Moves a whole face by one displacement (one undo step). `then` runs after the new state arrives.
  moveFace(sessionId: number, hexId: number, face: HexFaceName, delta: MeshPointDto, then?: () => void): void {
    this.run(sessionId, this.api.moveFace(sessionId, hexId, face, delta), then);
  }

  // Moves a whole edge by one displacement (one undo step).
  moveEdge(sessionId: number, hexId: number, edge: number, delta: MeshPointDto, then?: () => void): void {
    this.run(sessionId, this.api.moveEdge(sessionId, hexId, edge, delta), then);
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

  private run(sessionId: number, request: Observable<MeshCommandResultDto>, then?: () => void): void {
    this.busy.set(true);
    request.subscribe({
      next: result => {
        const invalidBefore = new Set(this.getState(sessionId)?.invalidHexes ?? []);
        this.accept(sessionId, result.state);
        // a move that folds a cube is never refused (the solver checks before solving), but it is said at once, so it is seen while it can still be taken back
        const folded = result.state.invalidHexes.filter(id => !invalidBefore.has(id));
        if (result.ok && folded.length > 0) this.notifications.warning(`Куб ${folded.join(', ')} вивернуто або виродилось: скасуйте крок або виправте перед розрахунком.`);
        if (!result.ok && result.error) this.notifications.warning(result.error);
        else if (result.ok && result.info) this.notifications.info(result.info);
        this.busy.set(false);
        if (result.ok) then?.();
      },
      error: () => {
        this.notifications.error('Не вдалось виконати команду: сервер недоступний.');
        this.busy.set(false);
      }
    });
  }
}
