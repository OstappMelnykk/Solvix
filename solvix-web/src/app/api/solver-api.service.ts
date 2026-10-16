import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { HexFaceName } from './mesh-editor-api.service';

// Wire shapes of Solvix.Api's SolverController (Solvix.Contracts/Facades/SolverDtos.cs). The backend owns
// the physics; this only carries what the user sets and what the solve returns.

export interface SolverMaterialDto {
  readonly name: string;
  readonly label: string;
  // Young's modulus, Pa.
  readonly e: number;
  // Poisson's ratio, [0, 0.5).
  readonly nu: number;
  // The colour on the scene, #rrggbb; without it the colour comes from the name.
  readonly color?: string;
}

// A face of a cube, or one small face of it: p, q are the cell in the side's grid (p along the lower of the face's
// two tangent axes, q along the higher); absent means the whole side.
export interface SolverFaceDto {
  readonly hex: number;
  readonly face: HexFaceName;
  readonly p?: number;
  readonly q?: number;
}

// One small element of a divided cube, by its index along each of the cube's axes.
export interface SolverElementDto {
  readonly hex: number;
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
}

export interface SolverElementMaterialDto extends SolverElementDto {
  readonly material: string;
}

export interface SolverLoadDto extends SolverFaceDto {
  // The solver's Pn, Pa: along the outward normal, so negative = compression, positive = pulling out.
  readonly pressure: number;
}

export interface SolverSetupDto {
  readonly version: number;
  // whether the last change of the set-up can be taken back, or a taken-back one put back
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  // Small elements each cube is cut into along its three axes (the solver's Nx, Ny, Nz).
  readonly divisions: readonly number[];
  readonly materials: readonly SolverMaterialDto[];
  readonly defaultMaterial: string;
  // hex id -> material name (cubes not listed use the default one).
  readonly hexMaterials: Readonly<Record<string, string>>;
  // Small elements with a material of their own, different from their cube's.
  readonly elementMaterials: readonly SolverElementMaterialDto[];
  readonly fixed: readonly SolverFaceDto[];
  readonly loads: readonly SolverLoadDto[];
}

export interface SolverIssueDto {
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface SolverValidationDto {
  readonly canSolve: boolean;
  readonly issues: readonly SolverIssueDto[];
}

export type SolverJobState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SolverJobDto {
  readonly state: SolverJobState;
  // 0..1
  readonly progress: number;
  readonly stage: string;
  readonly error: string | null;
  readonly ticket: number;
}

// The solution on the mesh the solver worked on: every cube cut into `divisions` small elements. Values are per
// node of that mesh; gridNodes says which node sits at each grid point of each cube.
export interface SolverResultDto {
  readonly ticket: number;
  readonly divisions: readonly number[];
  // x, y, z of each node (undeformed), flat.
  readonly positions: readonly number[];
  // The editor cube of each block of gridNodes.
  readonly hexIds: readonly number[];
  // Per cube, the node at each existing grid point (ix, iy, iz in 0..2n, at most one odd; iz slowest, ix fastest).
  readonly gridNodes: readonly number[];
  readonly ux: readonly number[];
  readonly uy: readonly number[];
  readonly uz: readonly number[];
  readonly vonMises: readonly number[];
  readonly maxDisplacement: number;
  readonly maxVonMises: number;
  readonly elapsedSeconds: number;
}

export type QualityGradeName = 'excellent' | 'good' | 'acceptable' | 'poor' | 'invalid';

export type QualityMetricKey = string;

// One measure of quality and where its grades change. With 4 levels `bounds` are the limits excellent | good |
// acceptable | poor; with 2 there is one limit and a value equal to it passes. Kind 'angleDeviation': the value is the
// distance of the worst angle from 90 degrees.
export interface SolverQualityLimitDto {
  readonly key: QualityMetricKey;
  readonly label: string;
  readonly short: string;
  readonly tech: string;
  readonly hint: string;
  readonly higherIsBetter: boolean;
  readonly levels: 2 | 4;
  readonly bounds: readonly number[];
  readonly unit: string;
  readonly decimals: number;
  readonly kind: 'plain' | 'angleDeviation';
  // beyond this the tool the limits come from refuses the element (shown for information; null if there is none)
  readonly errorBound: number | null;
}

// A small element (place ex, ey, ez in its cube) that is not excellent by a profile, with its value of every measure.
export interface SolverElementQualityDto {
  readonly hex: number;
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
  readonly grade: QualityGradeName;
  readonly values: Readonly<Record<string, number>>;
}

// How one standard (profile) judges the mesh, cut at the current division, element by element: counts per grade,
// the worst value of each measure, and the elements that are not excellent (every other one is excellent).
export interface SolverQualityDto {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly note: string;
  readonly elements: number;
  readonly grades: Readonly<Record<QualityGradeName, number>>;
  readonly worst: Readonly<Record<string, number>>;
  readonly limits: readonly SolverQualityLimitDto[];
  readonly flagged: readonly SolverElementQualityDto[];
}

// One standard's judgement of a single small element: its grade and its value of every measure of the standard.
export interface SolverElementProfileDto {
  readonly id: string;
  readonly grade: QualityGradeName;
  readonly values: Readonly<Record<string, number>>;
}

// Every standard's judgement of a single small element (for its details).
export interface SolverElementReportDto {
  readonly hex: number;
  readonly ex: number;
  readonly ey: number;
  readonly ez: number;
  readonly profiles: readonly SolverElementProfileDto[];
}

// The same mesh judged by every standard, so they can be compared.
export interface SolverQualityReportDto {
  readonly profiles: readonly SolverQualityDto[];
}

@Injectable({ providedIn: 'root' })
export class SolverApiService {
  private readonly http = inject(HttpClient);

  private url(sessionId: number, path: string): string {
    return `${environment.apiBaseUrl}/api/solver/${sessionId}/${path}`;
  }

  getSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.get<SolverSetupDto>(this.url(sessionId, 'setup'));
  }

  upsertMaterial(sessionId: number, material: SolverMaterialDto): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'materials'), material);
  }

  removeMaterial(sessionId: number, name: string): Observable<SolverSetupDto> {
    return this.http.delete<SolverSetupDto>(this.url(sessionId, `materials/${encodeURIComponent(name)}`));
  }

  setDefaultMaterial(sessionId: number, material: string): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'default-material'), { material });
  }

  // A null or empty name returns the cubes to the default material.
  // How many small elements each cube is cut into along its axes (1..8 each).
  setDivisions(sessionId: number, nx: number, ny: number, nz: number): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'divisions'), { nx, ny, nz });
  }

  // Gives small elements a material of their own; a null or empty name makes them follow their cube again.
  setElementMaterial(sessionId: number, elements: readonly SolverElementDto[], material: string | null): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'elements/material'), { elements, material });
  }

  setHexMaterial(sessionId: number, hexIds: readonly number[], material: string | null): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'hexes/material'), { hexIds, material });
  }

  setFixedFaces(sessionId: number, faces: readonly SolverFaceDto[], fixed: boolean): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/fixed'), { faces, fixed });
  }

  // Exactly these faces become the clamped ones.
  replaceFixed(sessionId: number, faces: readonly SolverFaceDto[]): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/fixed'), { faces, fixed: true, replace: true });
  }

  // Exactly these faces carry the pressure, replacing every earlier one.
  replaceLoads(sessionId: number, faces: readonly SolverFaceDto[], pressure: number): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/load'), { faces, pressure, replace: true });
  }

  // A null pressure removes the load.
  setLoads(sessionId: number, faces: readonly SolverFaceDto[], pressure: number | null): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/load'), { faces, pressure });
  }

  // Takes back (and puts back) the last change of the set-up: the supports, pressures, materials, division.
  undoSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.post<SolverSetupDto>(this.url(sessionId, 'setup/undo'), {});
  }

  redoSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.post<SolverSetupDto>(this.url(sessionId, 'setup/redo'), {});
  }

  clearSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.delete<SolverSetupDto>(this.url(sessionId, 'setup'));
  }

  qualityOfElement(sessionId: number, element: { hex: number; ex: number; ey: number; ez: number }): Observable<SolverElementReportDto> {
    return this.http.get<SolverElementReportDto>(this.url(sessionId, 'quality/element'), { params: { hex: element.hex, ex: element.ex, ey: element.ey, ez: element.ez } });
  }

  quality(sessionId: number): Observable<SolverQualityReportDto> {
    return this.http.get<SolverQualityReportDto>(this.url(sessionId, 'quality'));
  }

  validate(sessionId: number): Observable<SolverValidationDto> {
    return this.http.post<SolverValidationDto>(this.url(sessionId, 'validate'), {});
  }

  solve(sessionId: number): Observable<SolverJobDto> {
    return this.http.post<SolverJobDto>(this.url(sessionId, 'solve'), {});
  }

  getJob(sessionId: number): Observable<SolverJobDto> {
    return this.http.get<SolverJobDto>(this.url(sessionId, 'job'));
  }

  cancel(sessionId: number): Observable<SolverJobDto> {
    return this.http.post<SolverJobDto>(this.url(sessionId, 'cancel'), {});
  }

  getResult(sessionId: number): Observable<SolverResultDto> {
    return this.http.get<SolverResultDto>(this.url(sessionId, 'result'));
  }
}
