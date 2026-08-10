import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';

import { routes } from './app.routes';
import { GEOMETRY_FILE_LOADERS } from './geometry/loaders/geometry-file-loader';
import { GltfFileLoader } from './geometry/loaders/gltf-file-loader';
import { StlFileLoader } from './geometry/loaders/stl-file-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    // Registered geometry import formats (ModelImportService dispatches to
    // whichever of these claims the file) - add a new format by writing one
    // more GeometryFileLoader class and adding one more line here, nothing
    // else changes (open/closed - see geometry/loaders/geometry-file-loader.ts).
    { provide: GEOMETRY_FILE_LOADERS, useExisting: GltfFileLoader, multi: true },
    { provide: GEOMETRY_FILE_LOADERS, useExisting: StlFileLoader, multi: true }
  ]
};
