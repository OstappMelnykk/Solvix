import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import * as THREE from 'three';
import { GEOMETRY_FILE_LOADERS } from './loaders/geometry-file-loader';

export class UnsupportedFileTypeError extends Error {
  constructor(readonly fileName: string) {
    super(`No registered loader can handle "${fileName}"`);
  }
}

// Dispatches to whichever registered GeometryFileLoader (see
// loaders/geometry-file-loader.ts) claims the file, by asking each in
// registration order (app.config.ts) - this class never names a concrete
// format itself, so adding one doesn't mean editing this file (open/closed).
// Optional injection: an isolated unit test that doesn't register any
// loaders still gets a working (if loader-less) service instead of a
// NullInjectorError.
@Injectable({ providedIn: 'root' })
export class ModelImportService {
  private readonly loaders = inject(GEOMETRY_FILE_LOADERS, { optional: true }) ?? [];

  loadFromFile(file: File): Observable<THREE.Object3D> {
    const loader = this.loaders.find(candidate => candidate.canHandle(file)); //find first
    if (!loader) {
      return throwError(() => new UnsupportedFileTypeError(file.name));
    }
    return loader.load(file);
  }

  // Drives the file-picker's `accept` attribute directly from whichever
  // loaders are actually registered, so a new GeometryFileLoader widens what
  // the picker accepts automatically - no template edit needed alongside it.
  getAcceptedExtensions(): string {
    return this.loaders.flatMap(loader => loader.extensions).join(',');
  }
}
