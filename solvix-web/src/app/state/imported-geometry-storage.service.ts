import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { ImportedGeometry } from './imported-geometry.service';
import { readJson, removeKey, writeJson } from './local-storage-json';

const STORAGE_KEY_PREFIX = 'solvix:imported-geometry:';

interface PlainVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface PersistedImportedGeometry {
  readonly objectJson: object;
  readonly fileName: string;
  readonly watertight: boolean;
  readonly meshCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly boundingSize: PlainVector3;
  readonly longestAxis: 0 | 1 | 2;
  readonly longestLength: number;
  readonly boundingBox: { readonly min: PlainVector3; readonly max: PlainVector3 };
}

function toPlainVector3(v: THREE.Vector3): PlainVector3 {
  return { x: v.x, y: v.y, z: v.z };
}

function fromPlainVector3(v: PlainVector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

// Same reload-survival reasoning as ModelStorageService - see its own header
// comment. `ImportedGeometry.object` is generically serialized the same way
// (Object3D.toJSON()/ObjectLoader); boundingSize/boundingBox aren't plain
// data (THREE.Vector3/Box3 have methods, so re-hydrating them needs their
// real constructors back, not just `JSON.parse`'s bare {x,y,z} objects) -
// everything else here already is.
@Injectable({ providedIn: 'root' })
export class ImportedGeometryStorageService {
  save(sessionId: number, geometry: ImportedGeometry): void {
    const persisted: PersistedImportedGeometry = {
      objectJson: geometry.object.toJSON(),
      fileName: geometry.fileName,
      watertight: geometry.watertight,
      meshCount: geometry.meshCount,
      triangleCount: geometry.triangleCount,
      vertexCount: geometry.vertexCount,
      boundingSize: toPlainVector3(geometry.boundingSize),
      longestAxis: geometry.longestAxis,
      longestLength: geometry.longestLength,
      boundingBox: { min: toPlainVector3(geometry.boundingBox.min), max: toPlainVector3(geometry.boundingBox.max) }
    };
    writeJson(STORAGE_KEY_PREFIX + sessionId, persisted);
  }

  load(sessionId: number): ImportedGeometry | null {
    const persisted = readJson<PersistedImportedGeometry>(STORAGE_KEY_PREFIX + sessionId);
    if (!persisted) {
      return null;
    }
    return {
      object: new THREE.ObjectLoader().parse(persisted.objectJson),
      fileName: persisted.fileName,
      watertight: persisted.watertight,
      meshCount: persisted.meshCount,
      triangleCount: persisted.triangleCount,
      vertexCount: persisted.vertexCount,
      boundingSize: fromPlainVector3(persisted.boundingSize),
      longestAxis: persisted.longestAxis,
      longestLength: persisted.longestLength,
      boundingBox: new THREE.Box3(fromPlainVector3(persisted.boundingBox.min), fromPlainVector3(persisted.boundingBox.max))
    };
  }

  delete(sessionId: number): void {
    removeKey(STORAGE_KEY_PREFIX + sessionId);
  }
}
