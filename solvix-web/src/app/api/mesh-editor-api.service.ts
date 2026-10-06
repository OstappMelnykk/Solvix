import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Wire shapes of Solvix.Api's MeshEditorController (Solvix.Contracts/
// Facades/MeshEditorDtos.cs) - the backend owns all geometry, this is only
// what it sends back for drawing.

export type HexFaceName = 'XMinus' | 'XPlus' | 'YMinus' | 'YPlus' | 'ZMinus' | 'ZPlus';
export type FaceStatus = 'Free' | 'Linked' | 'Candidate';

export interface MeshNodeDto {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  // Ideal-world position in DOUBLED lattice units (divide by 2).
  readonly idealX: number;
  readonly idealY: number;
  readonly idealZ: number;
}

export interface MeshHexDto {
  readonly id: number;
  readonly cellI: number;
  readonly cellJ: number;
  readonly cellK: number;
  // 20 node ids: slots 0..7 corners, 8..19 edge midpoints.
  readonly nodeIds: readonly number[];
}

export interface MeshLinkDto {
  readonly hexA: number;
  readonly faceA: HexFaceName;
  readonly hexB: number;
  readonly faceB: HexFaceName;
}

export interface MeshFaceDto {
  readonly hex: number;
  readonly face: HexFaceName;
  readonly status: FaceStatus;
  readonly otherHex: number | null;
  readonly otherFace: HexFaceName | null;
  readonly coincident: boolean | null;
  readonly gap: number | null;
}

export interface MeshStateDto {
  readonly version: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly nodes: readonly MeshNodeDto[];
  readonly hexes: readonly MeshHexDto[];
  readonly links: readonly MeshLinkDto[];
  readonly faces: readonly MeshFaceDto[];
  readonly invalidHexes: readonly number[];
}

export interface MeshCommandResultDto {
  readonly ok: boolean;
  readonly error: string | null;
  readonly state: MeshStateDto;
}

export interface MeshPointDto {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MeshMappingResultDto {
  readonly found: boolean;
  readonly point: MeshPointDto | null;
}

// The manual hex editor's slice of Solvix.Api (one service per tool that
// talks to the backend - see CadWorkspaceApiService's header comment).
@Injectable({ providedIn: 'root' })
export class MeshEditorApiService {
  private readonly http = inject(HttpClient);

  private url(sessionId: number, path: string): string {
    return `${environment.apiBaseUrl}/api/mesh-editor/${sessionId}/${path}`;
  }

  getState(sessionId: number): Observable<MeshStateDto> {
    return this.http.get<MeshStateDto>(this.url(sessionId, 'state'));
  }

  addFirstHex(sessionId: number): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'hexes/first'), {});
  }

  addHexOnFace(sessionId: number, hexId: number, face: HexFaceName): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}/faces/${face}/attach`), {});
  }

  linkFaces(
    sessionId: number,
    hexA: number,
    faceA: HexFaceName,
    hexB: number,
    faceB: HexFaceName,
    adaptSecond: boolean
  ): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'links'), { hexA, faceA, hexB, faceB, adaptSecond });
  }

  // Links two lattice-adjacent cubes; the shared face is found by the server.
  linkHexes(sessionId: number, hexA: number, hexB: number, adaptSecond: boolean): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'links/by-hexes'), { hexA, hexB, adaptSecond });
  }

  unlinkFace(sessionId: number, hexId: number, face: HexFaceName): Observable<MeshCommandResultDto> {
    return this.http.delete<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}/faces/${face}/link`));
  }

  moveNode(sessionId: number, nodeId: number, position: MeshPointDto, carryEdgeMidpoints: boolean): Observable<MeshCommandResultDto> {
    return this.http.put<MeshCommandResultDto>(this.url(sessionId, `nodes/${nodeId}`), { ...position, carryEdgeMidpoints });
  }

  undo(sessionId: number): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'undo'), {});
  }

  redo(sessionId: number): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'redo'), {});
  }

  reset(sessionId: number): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'reset'), {});
  }

  mapIdealToReal(sessionId: number, ideal: MeshPointDto): Observable<MeshMappingResultDto> {
    return this.http.post<MeshMappingResultDto>(this.url(sessionId, 'map/ideal-to-real'), ideal);
  }

  mapRealToIdeal(sessionId: number, real: MeshPointDto): Observable<MeshMappingResultDto> {
    return this.http.post<MeshMappingResultDto>(this.url(sessionId, 'map/real-to-ideal'), real);
  }
}
