import { Observable, of } from 'rxjs';
import * as THREE from 'three';
import { ExtensionBasedFileLoader } from './geometry-file-loader';

class FakeExtensionLoader extends ExtensionBasedFileLoader {
  readonly extensions = ['.foo', '.foobar'];

  load(): Observable<THREE.Object3D> {
    return of(new THREE.Group());
  }
}

function fileNamed(name: string): File {
  return new File([], name);
}

describe('ExtensionBasedFileLoader', () => {
  let loader: FakeExtensionLoader;

  beforeEach(() => {
    loader = new FakeExtensionLoader();
  });

  it('matches a file whose name ends with one of its extensions', () => {
    expect(loader.canHandle(fileNamed('model.foo'))).toBe(true);
    expect(loader.canHandle(fileNamed('model.foobar'))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(loader.canHandle(fileNamed('MODEL.FOO'))).toBe(true);
  });

  it('does not match a file with a different extension', () => {
    expect(loader.canHandle(fileNamed('model.bar'))).toBe(false);
  });
});