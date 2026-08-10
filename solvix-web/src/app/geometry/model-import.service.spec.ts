import { TestBed } from '@angular/core/testing';
import { Observable, of, firstValueFrom } from 'rxjs';
import * as THREE from 'three';
import { ModelImportService, UnsupportedFileTypeError } from './model-import.service';
import { GEOMETRY_FILE_LOADERS, GeometryFileLoader } from './loaders/geometry-file-loader';

// A loader ModelImportService has never heard of - registered purely
// through the multi-token, exactly like a real new-format loader would be
// (app.config.ts). If dispatch works for this without touching
// ModelImportService's source, the open/closed contract holds.
class FakeFooLoader implements GeometryFileLoader {
  readonly extensions = ['.foo'];
  readonly result = new THREE.Group();

  canHandle(file: File): boolean {
    return file.name.toLowerCase().endsWith('.foo');
  }

  load(): Observable<THREE.Object3D> {
    return of(this.result);
  }
}

function fileNamed(name: string): File {
  return new File([], name);
}

describe('ModelImportService', () => {
  let fakeLoader: FakeFooLoader;
  let service: ModelImportService;

  beforeEach(() => {
    fakeLoader = new FakeFooLoader();
    TestBed.configureTestingModule({
      providers: [{ provide: GEOMETRY_FILE_LOADERS, useValue: fakeLoader, multi: true }]
    });
    service = TestBed.inject(ModelImportService);
  });

  it('dispatches to whichever registered loader claims the file, by extension', async () => {
    const object = await firstValueFrom(service.loadFromFile(fileNamed('model.foo')));
    expect(object).toBe(fakeLoader.result);
  });

  it('rejects with UnsupportedFileTypeError when no registered loader claims the file', async () => {
    await expectAsync(firstValueFrom(service.loadFromFile(fileNamed('model.bar')))).toBeRejectedWith(
      jasmine.any(UnsupportedFileTypeError)
    );
  });

  it('builds the accepted-extensions string from whichever loaders are registered', () => {
    expect(service.getAcceptedExtensions()).toBe('.foo');
  });

  it('does not throw when no loaders are registered at all (optional injection)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const bareService = TestBed.inject(ModelImportService);
    expect(bareService.getAcceptedExtensions()).toBe('');
  });
});