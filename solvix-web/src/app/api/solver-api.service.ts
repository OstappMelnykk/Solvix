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

export interface SolverFaceDto {
  readonly hex: number;
  readonly face: HexFaceName;
}

export interface SolverLoadDto extends SolverFaceDto {
  // Pa, positive = pressing into the body.
  readonly pressure: number;
}

export interface SolverSetupDto {
  readonly version: number;
  readonly materials: readonly SolverMaterialDto[];
  readonly defaultMaterial: string;
  // hex id -> material name (cubes not listed use the default one).
  readonly hexMaterials: Readonly<Record<string, string>>;
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

// Per solver node, aligned with nodeIds (editor node ids).
export interface SolverResultDto {
  readonly ticket: number;
  readonly nodeIds: readonly number[];
  readonly ux: readonly number[];
  readonly uy: readonly number[];
  readonly uz: readonly number[];
  readonly vonMises: readonly number[];
  readonly maxDisplacement: number;
  readonly maxVonMises: number;
  readonly elapsedSeconds: number;
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
  setHexMaterial(sessionId: number, hexIds: readonly number[], material: string | null): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'hexes/material'), { hexIds, material });
  }

  setFixedFaces(sessionId: number, faces: readonly SolverFaceDto[], fixed: boolean): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/fixed'), { faces, fixed });
  }

  // A null pressure removes the load.
  setLoads(sessionId: number, faces: readonly SolverFaceDto[], pressure: number | null): Observable<SolverSetupDto> {
    return this.http.put<SolverSetupDto>(this.url(sessionId, 'faces/load'), { faces, pressure });
  }

  clearSetup(sessionId: number): Observable<SolverSetupDto> {
    return this.http.delete<SolverSetupDto>(this.url(sessionId, 'setup'));
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
