import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIf } from '@angular/common';
import * as THREE from 'three';
import { IDEAL_WORLD_INDEX } from '../../config/app-settings';
import { ActiveWorldService } from '../../state/active-world.service';
import { SessionsService } from '../../state/sessions.service';
import { ImportedGeometryService } from '../../state/imported-geometry.service';
import { ImportedReferenceRenderService } from '../../state/imported-reference-render.service';
import { ModelImportService } from '../../geometry/model-import.service';
import { ModelLibraryApiService, ModelLibraryEntryDto } from '../../api/model-library-api.service';
import { disposeObject3D } from '../../geometry/dispose-object3d';
import { ImportedReferenceControlsComponent } from './imported-reference-controls/imported-reference-controls.component';
import { ModelLibraryPickerComponent } from './model-library-picker/model-library-picker.component';

type ImportDisplayStatus =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'success'; fileName: string }
  | { kind: 'not-watertight'; fileName: string }
  | { kind: 'none' };

type UploadDisplayStatus = { kind: 'idle' } | { kind: 'uploading' } | { kind: 'error' } | { kind: 'done'; fileName: string };

// (sessionId, worldIndex) together identify which World's settings this
// panel shows - both are read directly from the currently active session,
// since there's only one shared settings panel for the whole app now. Both
// are null when no session is open - AppComponent hides this component
// entirely in that state, but the computeds stay null-safe regardless.
@Component({
  selector: 'app-settings-panel',
  standalone: true,
  imports: [NgIf, ImportedReferenceControlsComponent, ModelLibraryPickerComponent],
  templateUrl: './settings-panel.component.html',
  styleUrl: './settings-panel.component.scss'
})
export class SettingsPanelComponent {
  private readonly sessions = inject(SessionsService);
  private readonly activeWorld = inject(ActiveWorldService);
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly referenceRender = inject(ImportedReferenceRenderService);
  private readonly modelImport = inject(ModelImportService);
  private readonly modelLibraryApi = inject(ModelLibraryApiService);
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

  // The server-side model library (Solvix.Api's ModelLibraryController) -
  // one shared list across all sessions/worlds, unlike transientStatus
  // above which is per-session. "Надіслати файл на сервер" adds to it,
  // "Обрати сітку" opens ModelLibraryPickerComponent to pick the "active
  // mesh" out of it, and "Імпортувати" feeds the picked entry's downloaded
  // bytes through the exact same loadFromFile/onFileLoaded/onFileLoadError
  // path as a direct local import.
  readonly libraryEntries = signal<ModelLibraryEntryDto[]>([]);
  readonly selectedLibraryId = signal<string | null>(null);
  // "Обрати сітку" opens ModelLibraryPickerComponent (a grid of preview
  // cards) instead of a plain <select> - this just tracks whether that
  // modal is currently open.
  readonly isPickerOpen = signal(false);
  private readonly uploadStatus = signal<UploadDisplayStatus>({ kind: 'idle' });

  constructor() {
    effect(
      () => {
        this.sessionId();
        this.transientStatus.set('idle');
      },
      { allowSignalWrites: true }
    );
    this.refreshLibrary();
  }

  private refreshLibrary(): void {
    this.modelLibraryApi
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: entries => this.libraryEntries.set(entries) });
  }

  // Uploads the picked file to the server library - a separate action from
  // onImportFile above, which loads a file straight into the current
  // session without ever touching the server. This one does the opposite:
  // it reaches the library, not the session, so a later "Імпортувати" can
  // load the same bytes into ANY session/world, not just this one.
  onUploadFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    this.uploadStatus.set({ kind: 'uploading' });
    file
      .arrayBuffer()
      .then(bytes =>
        this.modelLibraryApi
          .upload(file.name, bytes)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: entry => {
              this.uploadStatus.set({ kind: 'done', fileName: entry.fileName });
              this.selectedLibraryId.set(entry.id);
              this.refreshLibrary();
            },
            error: () => this.uploadStatus.set({ kind: 'error' })
          })
      )
      .catch(() => this.uploadStatus.set({ kind: 'error' }));
  }

  getUploadStatusText(): string | null {
    const status = this.uploadStatus();
    switch (status.kind) {
      case 'uploading':
        return 'Надсилання…';
      case 'done':
        return `${status.fileName} — надіслано ✓`;
      case 'error':
        return 'Не вдалось надіслати файл';
      case 'idle':
        return null;
    }
  }

  isUploadError(): boolean {
    return this.uploadStatus().kind === 'error';
  }

  getSelectedLibraryFileName(): string | null {
    return this.libraryEntries().find(entry => entry.id === this.selectedLibraryId())?.fileName ?? null;
  }

  openLibraryPicker(): void {
    this.isPickerOpen.set(true);
  }

  onLibraryPicked(entry: ModelLibraryEntryDto): void {
    this.selectedLibraryId.set(entry.id);
    this.isPickerOpen.set(false);
  }

  onLibraryPickerClosed(): void {
    this.isPickerOpen.set(false);
  }

  // Downloads the picker-selected library entry's bytes and feeds them
  // through the SAME loadFromFile/onFileLoaded/onFileLoadError path as
  // onImportFile - reconstructing a File from the downloaded bytes plus
  // the entry's remembered original fileName is enough for
  // ModelImportService's extension-based loader dispatch to work
  // unchanged (it matches purely on File.name).
  onImportFromLibrary(): void {
    const entry = this.libraryEntries().find(candidate => candidate.id === this.selectedLibraryId());
    const sessionId = this.sessionId();
    if (!entry || sessionId === null) {
      return;
    }

    this.transientStatus.set('loading');
    this.modelLibraryApi
      .download(entry.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: bytes => {
          const file = new File([bytes], entry.fileName);
          this.modelImport
            .loadFromFile(file)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: object => this.onFileLoaded(sessionId, entry.fileName, object),
              error: () => this.onFileLoadError(sessionId)
            });
        },
        error: () => this.onFileLoadError(sessionId)
      });
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
    this.referenceRender.resetRotation(sessionId);
    this.referenceRender.refreshScaledReference(sessionId);
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