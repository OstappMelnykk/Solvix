import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIf } from '@angular/common';
import * as THREE from 'three';
import { IDEAL_WORLD_INDEX } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
import { ModelImportService } from '../../geometry/model-import.service';
import { disposeObject3D } from '../../geometry/dispose-object3d';

type ImportDisplayStatus =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'success'; fileName: string }
  | { kind: 'not-watertight'; fileName: string }
  | { kind: 'none' };

// (sessionId, worldIndex) together identify which World's settings this
// panel shows - both are read directly from the currently active session,
// since there's only one shared settings panel for the whole app now. Both
// are null when no session is open - AppComponent hides this component
// entirely in that state, but the computeds stay null-safe regardless.
@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [NgIf],
  templateUrl: './settings-panel.component.html',
  styleUrl: './settings-panel.component.scss'
})
export class SettingsPanelComponent {
  private readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly modelImport = inject(ModelImportService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sessionId = computed(() => this.sessions.activeSessionId());
  readonly worldIndex = this.activeWorld.currentWorldIndex;
  readonly isIdealWorld = computed(() => this.worldIndex() === IDEAL_WORLD_INDEX);

  // Which formats the file picker accepts - driven by whichever
  // GeometryFileLoaders are actually registered (app.config.ts), so a new
  // loader widens this automatically instead of needing a template edit.
  readonly acceptedExtensions = this.modelImport.getAcceptedExtensions();

  // Only for the in-flight import action itself (loading/error) - what's
  // actually imported (success/not-watertight/none) is read fresh from
  // ImportedGeometryService per active session in getImportDisplayStatus(),
  // not cached here, so switching sessions can't show a stale result from a
  // DIFFERENT session's import.
  private readonly transientStatus = signal<'idle' | 'loading' | 'error'>('idle');

  constructor() {
    effect(
      () => {
        this.sessionId();
        this.transientStatus.set('idle');
      },
      { allowSignalWrites: true }
    );
  }

  // Recommended path: export from Blender as glTF 2.0 / "glTF Binary"
  // (.glb), or drop in an .stl straight from a mechanical-parts library
  // (Thingiverse, GrabCAD) - see geometry/loaders/. The imported object is
  // reference geometry only (ImportedGeometryService), not the session's
  // working model - future features (e.g. voxelization) will need a
  // watertight mesh to work correctly, hence surfacing that check's result
  // here instead of failing silently later.
  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    const sessionId = this.sessionId();
    if (!file || sessionId === null) {
      return;
    }

    this.transientStatus.set('loading');
    this.modelImport
      .loadFromFile(file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: object => this.onFileLoaded(sessionId, file.name, object),
        error: () => this.onFileLoadError(sessionId)
      });
  }

  // `sessionId` is whichever session was active WHEN THE LOAD STARTED - the
  // async load may resolve well after the user has switched to a different
  // session (transientStatus must not clobber THAT session's state, hence
  // the `this.sessionId() === sessionId` guards below) or closed the
  // original session entirely (nothing left to attach the loaded object to -
  // and unlike a still-open session, nothing will ever prune it, so it has
  // to be disposed here instead of resurrecting a pruned entry).
  private onFileLoaded(sessionId: number, fileName: string, object: THREE.Object3D): void {
    if (!this.sessionExists(sessionId)) {
      disposeObject3D(object);
      return;
    }
    this.importedGeometry.set(sessionId, object, fileName);
    if (this.sessionId() === sessionId) {
      this.transientStatus.set('idle');
    }
  }

  private onFileLoadError(sessionId: number): void {
    if (this.sessionId() === sessionId) {
      this.transientStatus.set('error');
    }
  }

  private sessionExists(sessionId: number): boolean {
    return this.sessions.sessions().some(session => session.id === sessionId);
  }

  // Called from the template each change-detection cycle (same pattern as
  // RenderWindowComponent.getRepresentation - ImportedGeometryService isn't
  // signal-backed) so it always reflects whichever session is CURRENTLY
  // active, not whichever one last imported something.
  getImportDisplayStatus(): ImportDisplayStatus {
    if (this.transientStatus() === 'loading') {
      return { kind: 'loading' };
    }
    if (this.transientStatus() === 'error') {
      return { kind: 'error' };
    }

    const sessionId = this.sessionId();
    const info = sessionId === null ? null : this.importedGeometry.get(sessionId);
    if (!info) {
      return { kind: 'none' };
    }
    return info.watertight ? { kind: 'success', fileName: info.fileName } : { kind: 'not-watertight', fileName: info.fileName };
  }
}