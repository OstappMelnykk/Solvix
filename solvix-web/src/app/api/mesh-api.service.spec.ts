import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { MeshApiService, parseInvalidMeshError, parseVoxelizationTooLargeError } from './mesh-api.service';
import { VoxelGridDto } from '../geometry/voxel-grid-contract';

// Builds the exact byte layout Solvix.Voxelization's internal
// VoxelizationResultBinarySerializer produces, mirroring
// voxel-grid-contract.spec.ts's helper.
function encodeGrid(): ArrayBuffer {
  const buffer = new ArrayBuffer(29);
  const view = new DataView(buffer);
  view.setFloat32(0, -0.5, true);
  view.setFloat32(4, -0.5, true);
  view.setFloat32(8, -0.5, true);
  view.setFloat32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new Uint8Array(buffer, 28).set([0b1]);
  return buffer;
}

describe('MeshApiService', () => {
  let meshApi: MeshApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    meshApi = TestBed.inject(MeshApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('POSTs the binary mesh buffer to /api/meshes/voxelize and decodes the binary grid response', () => {
    const mesh = new ArrayBuffer(8);

    let received: VoxelGridDto | undefined;
    meshApi.voxelize(mesh).subscribe(result => (received = result));

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBe(mesh);
    expect(request.request.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(request.request.responseType).toBe('arraybuffer');

    request.flush(encodeGrid());

    expect(received?.origin).toEqual({ x: -0.5, y: -0.5, z: -0.5 });
    expect(received?.cellSize).toBe(1);
    expect(received?.countX).toBe(1);
  });
});

describe('parseVoxelizationTooLargeError', () => {
  function errorResponseWithArrayBufferBody(body: unknown): HttpErrorResponse {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return new HttpErrorResponse({ error: bytes.buffer, status: 400 });
  }

  it('decodes the ArrayBuffer error body into { cellCount, limit }', () => {
    const result = parseVoxelizationTooLargeError(errorResponseWithArrayBufferBody({ cellCount: 8000000, limit: 900000 }));

    expect(result).toEqual({ cellCount: 8000000, limit: 900000 });
  });

  it('returns null when the error body is not an ArrayBuffer', () => {
    const result = parseVoxelizationTooLargeError(new HttpErrorResponse({ error: 'network error', status: 0 }));

    expect(result).toBeNull();
  });

  it('returns null when the decoded body is missing cellCount/limit', () => {
    const result = parseVoxelizationTooLargeError(errorResponseWithArrayBufferBody({ message: 'server error' }));

    expect(result).toBeNull();
  });
});

describe('parseInvalidMeshError', () => {
  function errorResponseWithArrayBufferBody(body: unknown): HttpErrorResponse {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return new HttpErrorResponse({ error: bytes.buffer, status: 400 });
  }

  it('decodes the ArrayBuffer error body into { message }', () => {
    const result = parseInvalidMeshError(errorResponseWithArrayBufferBody({ message: 'bad mesh' }));

    expect(result).toEqual({ message: 'bad mesh' });
  });

  it('returns null when the decoded body is missing message', () => {
    const result = parseInvalidMeshError(errorResponseWithArrayBufferBody({ cellCount: 5000, limit: 1000 }));

    expect(result).toBeNull();
  });

  it('returns null when the error body is not an ArrayBuffer', () => {
    const result = parseInvalidMeshError(new HttpErrorResponse({ error: 'network error', status: 0 }));

    expect(result).toBeNull();
  });
});