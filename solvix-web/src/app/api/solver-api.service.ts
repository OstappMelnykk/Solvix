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

export interface SolverCubeQualityDto {
  readonly hex: number;
  readonly grade: QualityGradeName;
  readonly scaledJacobian: number;
  readonly jacobianRatio: number;
  readonly aspectRatio: number;
  readonly skewDegrees: number;
}

// How well the mesh, cut at the current division, can be integrated: the worst small element of each cube, counts
// per grade over all small elements, and the worst values overall.
export interface SolverQualityDto {
  readonly elements: number;
  readonly grades: Readonly<Record<QualityGradeName, number>>;
  readonly worstScaledJacobian: number;
  readonly worstJacobianRatio: number;
  readonly worstAspectRatio: number;
  readonly worstSkewDegrees: number;
  readonly cubes: readonly SolverCubeQualityDto[];
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

  clearSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.delete<SolverSetupDto>(this.url(sessionId, 'setup'));
  }

  quality(sessionId: number): Observable<SolverQualityDto> {
    return this.http.get<SolverQualityDto>(this.url(sessionId, 'quality'));
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
