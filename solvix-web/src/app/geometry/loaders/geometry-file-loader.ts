import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import * as THREE from 'three';

// Strategy interface (GoF): one implementation per supported file format.
// ModelImportService (../model-import.service.ts) depends only on this
// contract, never on a concrete format - adding support for a new format
// means writing one new class that implements it and registering that class
// against GEOMETRY_FILE_LOADERS below (see app.config.ts), without touching
// ModelImportService or any existing loader (open/closed).
//
// Deliberately an interface, not an abstract class, even though an abstract
// class could also serve as a DI token here (unlike an interface, it
// doesn't vanish at compile time). A class can only `extends` one parent -
// making this contract a class would force every loader into ONE fixed
// inheritance chain forever. `implements` has no such limit: a loader can
// pick up ExtensionBasedFileLoader's shared code below AND still extend
// something else entirely if it ever needs to.
export interface GeometryFileLoader {
  // Lowercase, dot-prefixed (e.g. '.glb') - also drives the file-picker's
  // `accept` list (ModelImportService.getAcceptedExtensions), so a new
  // loader's formats show up there automatically too.
  readonly extensions: readonly string[];
  canHandle(file: File): boolean;
  load(file: File): Observable<THREE.Object3D>;
}

// Template Method (GoF): the one piece every extension-based loader needs
// (matching by filename suffix) implemented once - concrete loaders only
// supply `extensions` and `load`. Not mandatory - a format that needs
// smarter detection than "ends with X" (e.g. sniffing magic bytes) can
// implement GeometryFileLoader directly instead of extending this.
export abstract class ExtensionBasedFileLoader implements GeometryFileLoader {
  abstract readonly extensions: readonly string[];

  canHandle(file: File): boolean {
    const name = file.name.toLowerCase();
    return this.extensions.some(extension => name.endsWith(extension));
  }

  abstract load(file: File): Observable<THREE.Object3D>;
}

// Multi-token registry (Angular's idiom for "open" plugin points): every
// provider registered against this token - see app.config.ts - is one more
// entry ModelImportService tries, in registration order. No `providedIn`
// default here on purpose - which loaders exist is an app-composition
// decision (app.config.ts), not something this token should silently
// default on its own.
export const GEOMETRY_FILE_LOADERS = new InjectionToken<GeometryFileLoader[]>('GEOMETRY_FILE_LOADERS');