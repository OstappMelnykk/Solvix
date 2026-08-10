import { Injectable } from '@angular/core';
import { Observable, from, map } from 'rxjs';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ExtensionBasedFileLoader } from './geometry-file-loader';

// .stl - no Blender round-trip needed, the format most free mechanical-part
// libraries (Thingiverse, GrabCAD) already distribute directly. Pure
// triangle geometry, no material/scene graph, often already watertight
// since STL is itself a 3D-printing format. STLLoader.parse is synchronous
// (unlike GLTFLoader.parse) and handles both binary and ASCII STL.
@Injectable({ providedIn: 'root' })
export class StlFileLoader extends ExtensionBasedFileLoader {
  readonly extensions = ['.stl'] as const;

  private readonly loader = new STLLoader();

  load(file: File): Observable<THREE.Object3D> {
    return from(file.arrayBuffer()).pipe(
      map(buffer => new THREE.Mesh(this.loader.parse(buffer), new THREE.MeshStandardMaterial()))
    );
  }
}
