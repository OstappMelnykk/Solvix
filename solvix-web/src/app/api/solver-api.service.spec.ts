import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { SolverApiService } from './solver-api.service';

describe('SolverApiService', () => {
  let api: SolverApiService;
  let http: HttpTestingController;
  const base = `${environment.apiBaseUrl}/api/solver/5`;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(SolverApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function expectCall(method: string, path: string, body?: unknown) {
    const request = http.expectOne(`${base}/${path}`);
    expect(request.request.method).toBe(method);
    if (body !== undefined) expect(request.request.body).toEqual(body);
    request.flush({});
  }

  it('reads and clears the set-up', () => {
    api.getSetup(5).subscribe();
    expectCall('GET', 'setup');
    api.clearSetup(5).subscribe();
    expectCall('DELETE', 'setup');
  });

  it('sends materials, the default one and per-cube materials', () => {
    api.upsertMaterial(5, { name: 'glass', label: 'Скло', e: 7e10, nu: 0.22 }).subscribe();
    expectCall('PUT', 'materials', { name: 'glass', label: 'Скло', e: 7e10, nu: 0.22 });
    api.setDefaultMaterial(5, 'rubber').subscribe();
    expectCall('PUT', 'default-material', { material: 'rubber' });
    api.setHexMaterial(5, [1, 2], 'rubber').subscribe();
    expectCall('PUT', 'hexes/material', { hexIds: [1, 2], material: 'rubber' });
    api.setHexMaterial(5, [1], null).subscribe();
    expectCall('PUT', 'hexes/material', { hexIds: [1], material: null });
  });

  it('sends clamped faces and pressures', () => {
    const faces = [{ hex: 0, face: 'XMinus' as const }];
    api.setFixedFaces(5, faces, true).subscribe();
    expectCall('PUT', 'faces/fixed', { faces, fixed: true });
    api.setLoads(5, faces, 1e6).subscribe();
    expectCall('PUT', 'faces/load', { faces, pressure: 1e6 });
    api.setLoads(5, faces, null).subscribe();
    expectCall('PUT', 'faces/load', { faces, pressure: null });
  });

  it('sets the division of the cubes and replaces the clamped and pressed faces as a whole', () => {
    const faces = [{ hex: 1, face: 'ZPlus' as const }];
    api.setDivisions(5, 2, 3, 4).subscribe();
    expectCall('PUT', 'divisions', { nx: 2, ny: 3, nz: 4 });
    api.replaceFixed(5, faces).subscribe();
    expectCall('PUT', 'faces/fixed', { faces, fixed: true, replace: true });
    api.replaceLoads(5, faces, -2e6).subscribe();
    expectCall('PUT', 'faces/load', { faces, pressure: -2e6, replace: true });
  });

  it('validates, solves, polls, cancels and reads the result', () => {
    api.validate(5).subscribe();
    expectCall('POST', 'validate');
    api.solve(5).subscribe();
    expectCall('POST', 'solve');
    api.getJob(5).subscribe();
    expectCall('GET', 'job');
    api.cancel(5).subscribe();
    expectCall('POST', 'cancel');
    api.getResult(5).subscribe();
    expectCall('GET', 'result');
  });
});
