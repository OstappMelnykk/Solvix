import { Injectable } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ExtensionBasedFileLoader } from './geometry-file-loader';

// glTF 2.0 (.glb) - the recommended Blender export path (File > Export >
// glTF 2.0, format "glTF Binary"): one self-contained file, keeps
// hierarchy/materials. Draco-compressed exports are not supported (no
// DRACOLoader wired in). Deliberately NOT '.gltf' - Blender's "glTF
// Separate" splits into external .bin/texture files a single selected File
// can't resolve, so claiming that extension here would just fail loads
// that look like they should work.
@Injectable({ providedIn: 'root' })
export class GltfFileLoader extends ExtensionBasedFileLoader {
  readonly extensions = ['.glb'] as const;

  private readonly loader = new GLTFLoader();

  load(file: File): Observable<THREE.Object3D> {
    return from(file.arrayBuffer()).pipe(
      switchMap(
        buffer =>
          new Observable<THREE.Object3D>(subscriber => {
            this.loader.parse(
              buffer,
              '',
              gltf => {
                subscriber.next(gltf.scene);
                subscriber.complete();
              },
              error => subscriber.error(error)
            );
          })
      )
    );
  }
}