import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import * as THREE from 'three';
import { VoxelizationService } from './voxelization.service';
import { ImportedGeometryService } from './imported-geometry.service';
import { ImportedReferenceRenderService } from './imported-reference-render.service';
import { SessionsService } from './sessions.service';
import { environment } from '../../environments/environment';

function box(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return group;
}

// Builds the exact byte layout Solvix.Voxelization's internal
// VoxelizationResultBinarySerializer produces - what MeshApiService.voxelize
// actually receives over the wire (responseType: 'arraybuffer').
function encodeGrid(cellCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(29);
  const view = new DataView(buffer);
  view.setFloat32(0, 0, true);
  view.setFloat32(4, 0, true);
  view.setFloat32(8, 0, true);
  view.setFloat32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new Uint8Array(buffer, 28).set([cellCount > 0 ? 0b1 : 0b0]);
  return buffer;
}

function encodeTooLargeError(cellCount: number, limit: number): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({ cellCount, limit })).buffer as ArrayBuffer;
}

function encodeInvalidMeshError(message: string): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify({ message })).buffer as ArrayBuffer;
}

describe('VoxelizationService', () => {
  let sessions: SessionsService;
  let importedGeometry: ImportedGeometryService;
  let referenceRender: ImportedReferenceRenderService;
  let voxelization: VoxelizationService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    sessions = TestBed.inject(SessionsService);
    importedGeometry = TestBed.inject(ImportedGeometryService);
    referenceRender = TestBed.inject(ImportedReferenceRenderService);
    voxelization = TestBed.inject(VoxelizationService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('defaults to idle for a session that has never run voxelization', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'idle' });
  });

  it('does nothing when there is no scaled reference to voxelize', () => {
    const sessionId = sessions.sessions()[0].id;

    voxelization.run(sessionId);

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'idle' });
    httpMock.expectNone(`${environment.apiBaseUrl}/api/meshes/voxelize`);
  });

  it('goes through loading then ok on a successful response', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'loading' });

    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    const status = voxelization.getStatus(sessionId);
    expect(status.kind).toBe('ok');
    expect(status.kind === 'ok' && status.result.countX).toBe(1);
  });

  it('sends the CURRENT scaled reference (ImportedReferenceRenderService), not the raw import', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 20); // scale so longest side = 20

    voxelization.run(sessionId);

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`);
    // Binary wire format (geometry/mesh-contract.ts's toMeshBinary) -
    // [uint32 vertexCount][uint32 indexCount][vertexCount * 3 float32 x,y,z][indexCount * uint32].
    const view = new DataView(request.request.body as ArrayBuffer);
    const vertexCount = view.getUint32(0, true);
    const xs = Array.from({ length: vertexCount }, (_, i) => view.getFloat32(8 + i * 12, true));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 4);
    request.flush(encodeGrid(0));
  });

  it('reports too-large for MeshTooLargeException\'s 400 body shape', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock
      .expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`)
      .flush(encodeTooLargeError(5000, 1000), { status: 400, statusText: 'Bad Request' });

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'too-large', cellCount: 5000, limit: 1000 });
  });

  it('reports invalid-mesh for InvalidMeshException\'s 400 body shape', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock
      .expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`)
      .flush(encodeInvalidMeshError('bad mesh'), { status: 400, statusText: 'Bad Request' });

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'invalid-mesh', message: 'bad mesh' });
  });

  it('falls back to a generic error for any other failure response', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(new ArrayBuffer(0), { status: 500, statusText: 'Server Error' });

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'error' });
  });

  it("does not clobber a different session's status when a stale request resolves after switching", () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    importedGeometry.set(first, box(), 'first.glb');
    referenceRender.setDensity(first, 10);

    voxelization.run(first);
    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`);

    sessions.closeSession(first);
    TestBed.flushEffects();

    request.flush(encodeGrid(0));

    expect(voxelization.getStatus(second)).toEqual({ kind: 'idle' });
  });

  it("drops a closed session's status and leaves other sessions untouched", () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    importedGeometry.set(first, box(), 'first.glb');
    referenceRender.setDensity(first, 10);
    importedGeometry.set(second, box(), 'second.glb');
    referenceRender.setDensity(second, 10);

    voxelization.run(first);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(0));
    voxelization.run(second);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(0));

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(voxelization.getStatus(first)).toEqual({ kind: 'idle' });
    expect(voxelization.getStatus(second).kind).toBe('ok');
  });

  it('has no voxel preview before any successful run', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(voxelization.getVoxelPreview(sessionId)).toBeNull();
  });

  it('builds a voxel preview matching the response once a run succeeds', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    const preview = voxelization.getVoxelPreview(sessionId);
    expect(preview).not.toBeNull();
    const fill = preview!.children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    expect(fill.instanceCount).toBe(1);
  });

  it('keeps the last successful preview visible even if a later run fails', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    const firstPreview = voxelization.getVoxelPreview(sessionId);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(new ArrayBuffer(0), { status: 500, statusText: 'Server Error' });

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'error' });
    expect(voxelization.getVoxelPreview(sessionId)).toBe(firstPreview);
  });

  // Regression: BatchedMesh (the fill's renderer - see voxel-preview.ts)
  // can't be cloned per canvas, so WorldCanvasComponent now shows this
  // EXACT cached object rather than a clone of it - which means disposal
  // must happen in exactly one place, at the moment this service knows
  // for certain an object is being retired for good (superseded by a
  // newer run, same as here, or the session closing - see the next test).
  it('disposes the outgoing preview once a later run succeeds and replaces it', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    const firstPreview = voxelization.getVoxelPreview(sessionId)!;
    const firstFill = firstPreview.children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    const disposeSpy = spyOn(firstFill, 'dispose').and.callThrough();

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    expect(disposeSpy).toHaveBeenCalled();
    expect(voxelization.getVoxelPreview(sessionId)).not.toBe(firstPreview);
  });

  it("disposes a closed session's voxel preview and leaves other sessions untouched", () => {
    const first = sessions.sessions()[0].id;
    sessions.createSession();
    const second = sessions.sessions()[1].id;
    importedGeometry.set(first, box(), 'first.glb');
    referenceRender.setDensity(first, 10);
    importedGeometry.set(second, box(), 'second.glb');
    referenceRender.setDensity(second, 10);

    voxelization.run(first);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    voxelization.run(second);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    const secondPreview = voxelization.getVoxelPreview(second)!;
    const secondFill = secondPreview.children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    const geometryDispose = spyOn(secondFill, 'dispose');

    sessions.closeSession(first);
    TestBed.flushEffects();

    expect(voxelization.getVoxelPreview(first)).toBeNull();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(voxelization.getVoxelPreview(second)).toBe(secondPreview);
  });

  it('hides the result once the reference is rebuilt (density change) without a re-run', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    expect(voxelization.getStatus(sessionId).kind).toBe('ok');
    expect(voxelization.getVoxelPreview(sessionId)).not.toBeNull();

    referenceRender.setDensity(sessionId, 20); // rebuilds the scaled reference

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'idle' });
    expect(voxelization.getVoxelPreview(sessionId)).toBeNull();
  });

  // Regression: a rebuilt reference must actually DISPOSE the outdated
  // preview (freeing its GPU resources right away), not just hide it and
  // leave it cached until some later run happens to replace it.
  it('disposes the outdated preview (not just hides it) once the reference is rebuilt', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    const fill = voxelization
      .getVoxelPreview(sessionId)!
      .children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    const disposeSpy = spyOn(fill, 'dispose').and.callThrough();

    referenceRender.setDensity(sessionId, 20);

    expect(disposeSpy).toHaveBeenCalled();
  });

  it('shows the result again after re-running against the rebuilt reference', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    referenceRender.setDensity(sessionId, 20);
    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    expect(voxelization.getStatus(sessionId).kind).toBe('ok');
    expect(voxelization.getVoxelPreview(sessionId)).not.toBeNull();
  });

  // Regression: the density change above must not trigger voxelization to
  // run again on its own - it only ever starts from the explicit button.
  it('does not auto-re-run voxelization when the reference is rebuilt', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    referenceRender.setDensity(sessionId, 20);

    httpMock.expectNone(`${environment.apiBaseUrl}/api/meshes/voxelize`);
    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'idle' });
  });

  // Regression: if the reference changes WHILE a request is still in
  // flight, that request's eventual response must not resurrect a result
  // for geometry that no longer exists.
  it('discards an in-flight response if the reference changes before it arrives', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`);

    referenceRender.setDensity(sessionId, 20); // changes mid-request

    request.flush(encodeGrid(1));

    expect(voxelization.getStatus(sessionId)).toEqual({ kind: 'idle' });
    expect(voxelization.getVoxelPreview(sessionId)).toBeNull();
  });

  it('defaults opacity and clamps setOpacity to [0, 1]', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(voxelization.getOpacity(sessionId)).toBeCloseTo(0.55, 5);

    voxelization.setOpacity(sessionId, 1.5);
    expect(voxelization.getOpacity(sessionId)).toBe(1);

    voxelization.setOpacity(sessionId, -0.5);
    expect(voxelization.getOpacity(sessionId)).toBe(0);
  });

  it('applies the current opacity to a newly built preview', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);
    voxelization.setOpacity(sessionId, 0.3);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    const fill = voxelization
      .getVoxelPreview(sessionId)!
      .children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    expect((fill.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.3, 5);
  });

  it('updates an already-built preview live when opacity changes', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);
    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    voxelization.setOpacity(sessionId, 0.1);

    const fill = voxelization
      .getVoxelPreview(sessionId)!
      .children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
    expect((fill.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.1, 5);
  });

  it('defaults node size/opacity and clamps their setters to [0, 1]', () => {
    const sessionId = sessions.sessions()[0].id;
    expect(voxelization.getNodeSize(sessionId)).toBeCloseTo(0.5, 5);
    expect(voxelization.getNodeOpacity(sessionId)).toBe(1);

    voxelization.setNodeSize(sessionId, 1.5);
    expect(voxelization.getNodeSize(sessionId)).toBe(1);
    voxelization.setNodeSize(sessionId, -0.5);
    expect(voxelization.getNodeSize(sessionId)).toBe(0);

    voxelization.setNodeOpacity(sessionId, 1.5);
    expect(voxelization.getNodeOpacity(sessionId)).toBe(1);
    voxelization.setNodeOpacity(sessionId, -0.5);
    expect(voxelization.getNodeOpacity(sessionId)).toBe(0);
  });

  it('applies the current node size/opacity to a newly built preview', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);
    voxelization.setNodeSize(sessionId, 1);
    voxelization.setNodeOpacity(sessionId, 0.3);

    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));

    const nodes = voxelization
      .getVoxelPreview(sessionId)!
      .children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    expect((nodes.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.3, 5);
  });

  it('updates an already-built preview live when node size/opacity change', () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);
    voxelization.run(sessionId);
    httpMock.expectOne(`${environment.apiBaseUrl}/api/meshes/voxelize`).flush(encodeGrid(1));
    const preview = voxelization.getVoxelPreview(sessionId)!;
    const nodesBefore = preview.children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const radiusBefore = (nodesBefore.geometry as THREE.SphereGeometry).parameters.radius;

    voxelization.setNodeOpacity(sessionId, 0.2);
    voxelization.setNodeSize(sessionId, 1);

    const nodesAfter = preview.children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    expect((nodesAfter.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.2, 5);
    expect((nodesAfter.geometry as THREE.SphereGeometry).parameters.radius).toBeGreaterThan(radiusBefore);
  });

  it("discards a superseded run's response instead of letting it clobber a newer result", () => {
    const sessionId = sessions.sessions()[0].id;
    importedGeometry.set(sessionId, box(), 'model.glb');
    referenceRender.setDensity(sessionId, 10);

    voxelization.run(sessionId);
    voxelization.run(sessionId); // supersedes the first before it resolves

    const requests = httpMock.match(`${environment.apiBaseUrl}/api/meshes/voxelize`);
    expect(requests.length).toBe(2);
    const [firstRequest, secondRequest] = requests;

    secondRequest.flush(encodeGrid(1)); // the LATEST run resolves first
    expect(voxelization.getStatus(sessionId).kind).toBe('ok');

    firstRequest.flush(encodeGrid(0)); // the stale run resolves after - must be ignored
    const status = voxelization.getStatus(sessionId);
    expect(status.kind).toBe('ok');
    // encodeGrid(1) (the second/latest run) sets occupancy bit 0; encodeGrid(0)
    // (the stale first run) clears it - still 1 confirms the stale reply didn't win.
    expect(status.kind === 'ok' && status.result.occupancy[0]).toBe(1);
  });
});