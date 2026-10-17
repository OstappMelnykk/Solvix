import { Component, HostBinding, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { IDEAL_WORLD_INDEX, QUALITY_WORLD_INDEX, REAL_WORLD_INDEX, SOLVER_WORLD_INDEX, WORLDS_CONFIG } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { WorldRepresentation, WorldRepresentationService } from '../../state/world-representation.service';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
import { ImportedReferenceDisplayService, ImportedReferenceStyle } from '../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { SurfaceAttachmentService } from '../../state/surface-attachment.service';
import { SolverViewerComponent } from '../solver-viewer/solver-viewer.component';
import { SolverOverlayComponent } from '../solver-overlay/solver-overlay.component';
import { SolverService } from '../../state/solver.service';
import { SolverRenderService } from '../../state/solver-render.service';
import { QualityRenderService } from '../../state/quality-render.service';
import { MeshEditorRenderService } from '../../state/mesh-editor-render.service';
import { MeshEditorSelectionService } from '../../state/mesh-editor-selection.service';
import { MeshEditorService } from '../../state/mesh-editor.service';
import { HexFaceName } from '../../api/mesh-editor-api.service';
import { MeshPick, MeshView, faceMoveSets } from '../../geometry/mesh-editor-view';
import { GroundCell } from '../../geometry/ground-cell';
import { buildCommandFor } from '../../geometry/mesh-build';
import { MeshCountsComponent } from './mesh-counts/mesh-counts.component';
import { WorldTabsComponent } from './world-tabs/world-tabs.component';
import { WorldCanvasComponent } from './world-canvas/world-canvas.component';
import * as THREE from 'three';

// App-level, single instance - not one per session. Its 3 WorldCanvasComponent
// children are the only 3 WebGL contexts the app ever creates; switching
// sessions just changes which session's model they draw (see
// WorldRepresentationService), not which canvases exist. Stays mounted (see
// AppComponent's [hidden], not *ngIf) even when there are zero sessions
// open - the 3 canvases just show nothing until a session exists again.
const NO_NODES: ReadonlySet<number> = new Set<number>();

@Component({
  selector: 'app-render-window',
  standalone: true,
  imports: [NgFor, NgIf, WorldTabsComponent, WorldCanvasComponent, SolverOverlayComponent, SolverViewerComponent, MeshCountsComponent],
  templateUrl: './render-window.component.html',
  styleUrl: './render-window.component.scss'
})
export class RenderWindowComponent {
  readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);
  private readonly representations = inject(WorldRepresentationService);
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly importedReferenceDisplay = inject(ImportedReferenceDisplayService);
  private readonly importedReferenceRender = inject(ImportedReferenceRenderService);
  private readonly meshEditorRender = inject(MeshEditorRenderService);
  private readonly attachments = inject(SurfaceAttachmentService);
  private readonly qualityRender = inject(QualityRenderService);
  private readonly solverRender = inject(SolverRenderService);
  private readonly solver = inject(SolverService);
  private readonly meshSelection = inject(MeshEditorSelectionService);
  private readonly meshEditor = inject(MeshEditorService);
  // The full-window result viewer covers the whole app: only the body and the tools for looking at it remain.
  @HostBinding('class.render-window--viewer')
  get isViewer(): boolean {
    const sessionId = this.sessions.activeSessionId();
    return sessionId !== null && this.activeWorld.currentWorldIndex() === SOLVER_WORLD_INDEX && this.solver.viewer(sessionId) && this.solver.result(sessionId) !== null;
  }

  readonly worlds = WORLDS_CONFIG;
  readonly solverWorldIndex = SOLVER_WORLD_INDEX;

  // Where the pointer is followed to show what a click would act on: the Solver World, and the Ideal and Real Worlds while elements are being picked.
  hoverOn(worldIndex: number): boolean {
    if (worldIndex === SOLVER_WORLD_INDEX) return true;
    const sessionId = this.sessions.activeSessionId();
    return (worldIndex === IDEAL_WORLD_INDEX || worldIndex === REAL_WORLD_INDEX) && sessionId !== null && this.solver.refineMode(sessionId);
  }

  // null when there's no active session - never matches a real worldIndex,
  // so every WorldCanvasComponent ends up [hidden] and inactive, same as if
  // a World were simply never selected.
  readonly activeWorldIndex = this.activeWorld.currentWorldIndex;

  getRepresentation(worldIndex: number): WorldRepresentation | null {
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.representations.getRepresentation(sessionId, worldIndex);
  }

  // Ideal-World-only (see IDEAL_WORLD_INDEX) - shown as a visual guide
  // only, never part of `representation`. Prefers ImportedReferenceRenderService's
  // scaled clone (what "Розмір" in the settings panel actually controls) so
  // the user sees the SAME thing that any future size-dependent operation
  // would use, not the raw unscaled import - falls back to the raw object
  // only for the degenerate case where scaling isn't defined yet (e.g.
  // right after import, before refreshScaledReference has run). null when
  // hidden (ImportedReferenceDisplayService), same as if nothing were
  // imported at all - WorldCanvasComponent doesn't need to know visibility
  // is a separate concept from "is there anything to show".
  getImportedReference(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).visible) {
      return null;
    }
    return this.importedReferenceRender.getScaledReference(sessionId) ?? this.importedGeometry.get(sessionId)?.object ?? null;
  }

  // Ideal-World-only, same gating as getImportedReference - how to DRAW
  // whatever that returns. WorldCanvasComponent only reads this when
  // importedReference is itself non-null, so null here (no active
  // session) is never actually used to build anything.
  getImportedReferenceStyle(worldIndex: number): ImportedReferenceStyle | null {
    if (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    return sessionId === null ? null : this.importedReferenceDisplay.getStyle(sessionId);
  }

  // Ideal-World-only, independent of getImportedReference's own visibility
  // (ImportedReferenceStyle.dimensionsVisible) - the measured size can stay
  // on screen even while the geometry itself is hidden, or vice versa.
  getDimensionLines(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).dimensionsVisible) {
      return null;
    }
    return this.importedReferenceRender.getDimensionLines(sessionId);
  }

  // Ideal-World-only, independent of getImportedReference's own visibility
  // (ImportedReferenceStyle.rulerVisible) - same reasoning as getDimensionLines.
  getRuler(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).rulerVisible) {
      return null;
    }
    return this.importedReferenceRender.getRuler(sessionId);
  }

  // Ideal-World-only, independent of getImportedReference's own visibility
  // (ImportedReferenceStyle.holesVisible) - same reasoning as getDimensionLines.
  getHoleHighlight(worldIndex: number): THREE.Object3D | null {
    if (worldIndex !== IDEAL_WORLD_INDEX && worldIndex !== REAL_WORLD_INDEX) {
      return null;
    }
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null || !this.importedReferenceDisplay.getStyle(sessionId).holesVisible) {
      return null;
    }
    return this.importedReferenceRender.getHoleHighlight(sessionId);
  }

  // The mesh editor's drawing for this World (Ideal: lattice positions, Real:
  // real positions, Solver: nothing yet) - null until the session has a hex.
  getMeshView(worldIndex: number): MeshView | null {
    const sessionId = this.sessions.activeSessionId();
    if (worldIndex === SOLVER_WORLD_INDEX) return this.solverRender.getView(sessionId, worldIndex);
    if (worldIndex === QUALITY_WORLD_INDEX) return this.qualityRender.getView(sessionId, worldIndex);
    return this.meshEditorRender.getView(sessionId, worldIndex);
  }

  // The nodes stuck to the imported surface (Real World).
  getAttachedNodes(worldIndex: number): ReadonlySet<number> {
    const sessionId = this.sessions.activeSessionId();
    return worldIndex === REAL_WORLD_INDEX && sessionId !== null ? this.attachments.attached(sessionId) : NO_NODES;
  }

  placeOnSurface(): boolean {
    return this.attachments.placeMode();
  }

  // A click on the imported surface with a node selected: the node goes to that point and sticks to the surface.
  onSurfacePlace(event: { nodeId: number; position: { x: number; y: number; z: number } }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    const round = (v: number) => Math.round(v * 1e6) / 1e6;
    this.meshEditor.moveNode(sessionId, event.nodeId, { x: round(event.position.x), y: round(event.position.y), z: round(event.position.z) }, this.meshEditor.carryEdgeMidpoints, () => this.attachments.attach(sessionId, event.nodeId));
  }

  snapEnabled(): boolean {
    return this.attachments.snapEnabled();
  }

  snapShare(): number {
    return this.attachments.snapShare();
  }

  onNodeAttach(event: { nodeId: number; attached: boolean }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    if (event.attached) this.attachments.attach(sessionId, event.nodeId);
    else this.attachments.detach(sessionId, event.nodeId);
  }

  // Nodes are dragged only in the Real World; the Ideal World's lattice is fixed.
  getDraggableNodeId(worldIndex: number): number | null {
    const sessionId = this.sessions.activeSessionId();
    return worldIndex === REAL_WORLD_INDEX && sessionId !== null ? this.meshSelection.nodeId(sessionId) : null;
  }

  // The gizmo is being dragged: the Real World redraws live from the isoparametric map, before the server is asked.
  onNodeDragging(event: { nodeId: number; position: { x: number; y: number; z: number } }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId !== null) this.meshEditorRender.setDragPreview(sessionId, event.nodeId, event.position, this.meshEditor.carryEdgeMidpoints);
  }

  // The gizmo was dropped: send the node's new position to the server.
  onNodeMoved(event: { nodeId: number; position: { x: number; y: number; z: number } }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId !== null) {
      this.meshEditor.moveNode(sessionId, event.nodeId, event.position, this.meshEditor.carryEdgeMidpoints);
    }
  }

  // The face a plain click picked, draggable only in the Real World and only
  // while no node is picked (a node takes priority). Resolved into the ids the
  // canvas needs: the 8 face nodes (full delta) and the connecting edge midpoints
  // (half), plus the face centre the gizmo sits at.
  getDraggableFace(worldIndex: number): {
    hex: number;
    face: HexFaceName;
    fullNodeIds: number[];
    halfNodeIds: number[];
    center: { x: number; y: number; z: number };
  } | null {
    const sessionId = this.sessions.activeSessionId();
    if (worldIndex !== REAL_WORLD_INDEX || sessionId === null) return null;
    if (this.meshSelection.nodeId(sessionId) !== null) return null; // a picked node wins
    const face = this.meshSelection.face(sessionId);
    const state = this.meshEditor.getState(sessionId);
    if (!face || !state) return null;
    const sets = faceMoveSets(state, face.hex, face.face);
    if (!sets) return null;
    const fullNodeIds = [...sets.full];
    const halfNodeIds = [...sets.half];

    const nodeById = new Map(state.nodes.map(n => [n.id, n]));
    const pending = this.meshEditorRender.facePreviewDelta(sessionId);
    const center = { x: 0, y: 0, z: 0 };
    for (const id of fullNodeIds) {
      const n = nodeById.get(id);
      if (n) {
        center.x += n.x / fullNodeIds.length;
        center.y += n.y / fullNodeIds.length;
        center.z += n.z / fullNodeIds.length;
      }
    }
    // dragged and dropped, and the server has not answered yet: the gizmo stays where it was dropped
    if (pending) {
      center.x += pending.x;
      center.y += pending.y;
      center.z += pending.z;
    }
    return { hex: face.hex, face: face.face, fullNodeIds, halfNodeIds, center };
  }

  // The face gizmo was dropped: send the displacement to the server (one undo step).
  onFaceMoved(event: { hex: number; face: HexFaceName; delta: { x: number; y: number; z: number } }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    const { x, y, z } = event.delta;
    if (x === 0 && y === 0 && z === 0) return;
    this.meshEditor.moveFace(sessionId, event.hex, event.face, event.delta);
  }

  // The face gizmo is being dragged: redraw the whole Real World live from the
  // isoparametric map (curved edges, inner grid, neighbours), as for a node drag.
  onFaceDragging(event: { hex: number; face: HexFaceName; delta: { x: number; y: number; z: number } }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId !== null) this.meshEditorRender.setFaceDragPreview(sessionId, event.hex, event.face, event.delta);
  }

  // Building with the mouse is for the Ideal and the Real World, when the user has it on.
  isBuildOn(worldIndex: number): boolean {
    const sessionId = this.sessions.activeSessionId();
    return (worldIndex === IDEAL_WORLD_INDEX || worldIndex === REAL_WORLD_INDEX) && sessionId !== null && this.meshSelection.buildMode(sessionId, worldIndex);
  }

  // Right click: a cube on the face under the pointer, or - with no cubes yet - the first one in the ground cell under
  // it. Left click: the cube under the pointer goes (the server refuses a removal that would split the body).
  onMeshBuild(event: { action: 'add' | 'remove'; pick: MeshPick | null; ground: GroundCell | null }): void {
    const sessionId = this.sessions.activeSessionId();
    const world = this.activeWorldIndex();
    if (sessionId === null || world === null || !this.isBuildOn(world)) return;
    const command = buildCommandFor(event, this.meshEditor.getState(sessionId)?.hexes.length ?? 0);
    if (command?.kind === 'removeHex') this.meshEditor.removeHex(sessionId, command.hex);
    else if (command?.kind === 'addOnFace') this.meshEditor.addHexOnFace(sessionId, command.hex, command.face);
    else if (command?.kind === 'addFirst') this.meshEditor.addFirstHex(sessionId, undefined, command.cell);
  }

  // The brush paints in the Solver World with the Pressure, Support or Material tool.
  isBrushOn(worldIndex: number): boolean {
    const sessionId = this.sessions.activeSessionId();
    if (worldIndex !== SOLVER_WORLD_INDEX || sessionId === null) return false;
    const tool = this.solver.tool(sessionId);
    return this.solver.brush(sessionId) && tool !== 'view';
  }

  onPaint(event: { phase: 'start' | 'move' | 'end'; pick: MeshPick | null }): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    const pick = event.pick?.kind === 'face' ? event.pick : null;
    if (event.phase === 'start') this.solver.paintStart(sessionId, pick);
    else if (event.phase === 'move') this.solver.paintTo(sessionId, pick);
    else this.solver.paintEnd(sessionId);
    this.solverRender.refreshHighlight(sessionId);
  }

  // The pointer moved over the Solver World: what a click there would act on is highlighted, without rebuilding the view.
  onMeshHover(pick: MeshPick | null): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    const world = this.activeWorldIndex();
    if (world === IDEAL_WORLD_INDEX || world === REAL_WORLD_INDEX) {
      this.meshEditorRender.setRefineHover(sessionId, world, pick);
      return;
    }
    if (this.solver.setHover(sessionId, pick?.kind === 'face' ? pick : null)) this.solverRender.refreshHighlight(sessionId);
  }

  // A click on the canvas - see MeshEditorSelectionService.applyPick for what
  // each kind of click picks.
  onMeshPick(pick: MeshPick | null, additive: boolean): void {
    const sessionId = this.sessions.activeSessionId();
    if (sessionId === null) return;
    // while the elements of a refined body are being picked, a click in the Ideal and Real Worlds chooses elements to refine
    const world = this.activeWorldIndex();
    if ((world === IDEAL_WORLD_INDEX || world === REAL_WORLD_INDEX) && this.solver.refineMode(sessionId)) {
      this.solver.chooseByPick(sessionId, pick?.kind === 'face' ? pick : null);
      return;
    }
    // in the Solver World a click acts through the chosen tool (see SolverService.pick)
    if (this.activeWorldIndex() === SOLVER_WORLD_INDEX) this.solver.pick(sessionId, pick?.kind === 'face' ? pick : null);
    else if (this.activeWorldIndex() === QUALITY_WORLD_INDEX) {
      // a click on a small element picks it in the quality list; a click on nothing clears the pick
      if (pick?.kind === 'face' && pick.elementKey !== undefined) this.solver.setQualityPick(sessionId, { hex: pick.hex, ex: 0, ey: 0, ez: 0, key: pick.elementKey });
      else if (pick?.kind === 'face' && pick.element) this.solver.setQualityPick(sessionId, { hex: pick.hex, ex: pick.element[0], ey: pick.element[1], ez: pick.element[2] });
      else if (this.solver.qualityPick(sessionId) !== null) this.solver.setQualityPick(sessionId, null);
    } else this.meshSelection.applyPick(sessionId, pick, additive);
  }
}
