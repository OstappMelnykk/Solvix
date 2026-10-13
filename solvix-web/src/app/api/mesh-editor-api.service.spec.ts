import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { MeshEditorApiService } from './mesh-editor-api.service';
import { singleCubeState } from '../geometry/mesh-state.fixture.spec';

describe('MeshEditorApiService', () => {
  let api: MeshEditorApiService;
  let http: HttpTestingController;
  const base = `${environment.apiBaseUrl}/api/mesh-editor/5`;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(MeshEditorApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function expectCall(method: string, url: string, body?: unknown) {
    const request = http.expectOne(`${base}/${url}`);
    expect(request.request.method).toBe(method);
    if (body !== undefined) expect(request.request.body).toEqual(body);
    return request;
  }

  it('GETs the state of the session', () => {
    let received: unknown;
    api.getState(5).subscribe(state => (received = state));
    expectCall('GET', 'state').flush(singleCubeState());
    expect(received).toEqual(singleCubeState());
  });

  it('POSTs the first hex and an attach on a named face', () => {
    api.addFirstHex(5).subscribe();
    expectCall('POST', 'hexes/first').flush({});
    api.addHexOnFace(5, 3, 'XPlus').subscribe();
    expectCall('POST', 'hexes/3/faces/XPlus/attach').flush({});
  });

  it('POSTs a designed shape with the first cube and with an attach, and nothing extra without one', () => {
    const shape = { positions: [{ x: 0, y: 0, z: 0 }] };
    api.addFirstHex(5, shape).subscribe();
    expectCall('POST', 'hexes/first', { shape }).flush({});
    api.addHexOnFace(5, 3, 'YPlus', shape).subscribe();
    expectCall('POST', 'hexes/3/faces/YPlus/attach', { shape }).flush({});
  });

  it('POSTs the lattice cell the first cube starts in', () => {
    api.addFirstHex(5, undefined, { i: 3, j: 0, k: -2 }).subscribe();
    expectCall('POST', 'hexes/first', { cell: { i: 3, j: 0, k: -2 } }).flush({});
  });

  it('talks to the session-free shape and template endpoints', () => {
    const root = `${environment.apiBaseUrl}/api/mesh-editor/shapes`;
    api.shapePresets().subscribe();
    expect(http.expectOne(`${root}/presets`).request.method).toBe('GET');
    api.buildShape({ length: 1, height: 1, depth: 1, taper: 1, shearX: 0, shearZ: 0 }).subscribe();
    expect(http.expectOne(`${root}/parametric`).request.method).toBe('POST');
    api.checkShape({ positions: [] }).subscribe();
    expect(http.expectOne(`${root}/check`).request.method).toBe('POST');
    api.templateLibrary().subscribe();
    expect(http.expectOne(`${root}/templates`).request.method).toBe('GET');
    api.previewTemplate({ kind: 'pipe', values: { around: 6 } }).subscribe();
    const preview = http.expectOne(`${root}/templates/preview`);
    expect(preview.request.body).toEqual({ kind: 'pipe', values: { around: 6 } });
  });

  it('POSTs a template body into the session', () => {
    api.addTemplate(5, { kind: 'torus' }).subscribe();
    expectCall('POST', 'bodies', { kind: 'torus' }).flush({});
  });

  it('POSTs a link with both faces and the adapt flag', () => {
    api.linkFaces(5, 3, 'XPlus', 2, 'XMinus', true).subscribe();
    expectCall('POST', 'links', { hexA: 3, faceA: 'XPlus', hexB: 2, faceB: 'XMinus', adaptSecond: true }).flush({});
  });

  it('DELETEs the session itself', () => {
    api.dropSession(5).subscribe();
    const request = http.expectOne(`${environment.apiBaseUrl}/api/mesh-editor/5`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('DELETEs a cube', () => {
    api.removeHex(5, 3).subscribe();
    expectCall('DELETE', 'hexes/3').flush({});
  });

  it('POSTs a link between two cubes by id', () => {
    api.linkHexes(5, 3, 2, false).subscribe();
    expectCall('POST', 'links/by-hexes', { hexA: 3, hexB: 2, adaptSecond: false }).flush({});
  });

  it('DELETEs a face link', () => {
    api.unlinkFace(5, 3, 'YMinus').subscribe();
    expectCall('DELETE', 'hexes/3/faces/YMinus/link').flush({});
  });

  it('PUTs a node position with the carry flag', () => {
    api.moveNode(5, 9, { x: 1, y: 2, z: 3 }, false).subscribe();
    expectCall('PUT', 'nodes/9', { x: 1, y: 2, z: 3, carryEdgeMidpoints: false }).flush({});
  });

  it('POSTs undo, redo and reset', () => {
    api.undo(5).subscribe();
    expectCall('POST', 'undo').flush({});
    api.redo(5).subscribe();
    expectCall('POST', 'redo').flush({});
    api.reset(5).subscribe();
    expectCall('POST', 'reset').flush({});
  });

  it('POSTs the smoothing settings', () => {
    const options = { iterations: 12, relaxation: 0.5, surface: true, density: 1, featureAngle: 25, untangle: true, straighten: true, shapeTolerance: 0 };
    api.smooth(5, options).subscribe();
    expectCall('POST', 'smooth', options).flush({});
  });

  it('POSTs both mapping probes with the point as the body', () => {
    api.mapIdealToReal(5, { x: 1, y: 2, z: 3 }).subscribe();
    expectCall('POST', 'map/ideal-to-real', { x: 1, y: 2, z: 3 }).flush({ found: false, point: null });
    api.mapRealToIdeal(5, { x: 4, y: 5, z: 6 }).subscribe();
    expectCall('POST', 'map/real-to-ideal', { x: 4, y: 5, z: 6 }).flush({ found: false, point: null });
  });
});
