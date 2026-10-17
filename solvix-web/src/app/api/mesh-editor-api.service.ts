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
  // The named group (layer) the cube belongs to - enamel, dentin... - or null/absent.
  readonly layer?: string | null;
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
  // something worth telling the user about what the command did
  readonly info?: string | null;
}

export interface MeshPointDto {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// A cube designed on its own: the 20 node positions in slot order (0..7 corners,
// 8..19 edge midpoints).
export interface MeshShapeDto {
  readonly positions: readonly MeshPointDto[];
}

export interface MeshShapeCheckDto {
  readonly valid: boolean;
  readonly minDeterminant: number;
  readonly error: string | null;
}

export interface MeshShapeParametersDto {
  readonly length: number;
  readonly height: number;
  readonly depth: number;
  // Top size / bottom size (1 = straight sides).
  readonly taper: number;
  readonly shearX: number;
  readonly shearZ: number;
}

export interface MeshShapePresetDto {
  readonly name: string;
  readonly label: string;
  readonly parameters: MeshShapeParametersDto;
}

export interface MeshTemplateParameterDto {
  readonly key: string;
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
}

// A family of bodies (pipe, sphere, torus...): the layout is fixed by the kind, the parameters only size it.
export interface MeshTemplateKindDto {
  readonly name: string;
  readonly label: string;
  readonly group: string;
  readonly parameters: readonly MeshTemplateParameterDto[];
}

// A named starting point; parameters not listed keep the kind's defaults.
export interface MeshTemplatePresetDto {
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface MeshTemplateLibraryDto {
  readonly kinds: readonly MeshTemplateKindDto[];
  readonly presets: readonly MeshTemplatePresetDto[];
}

export interface MeshTemplateRequestDto {
  readonly kind: string;
  readonly values?: Readonly<Record<string, number>>;
}

export interface MeshTemplatePreviewDto {
  readonly ok: boolean;
  readonly error: string | null;
  readonly state: MeshStateDto | null;
  readonly foldedCubes: number;
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

  // Forgets the session's mesh and undo history on the server (a closed or restarted session).
  dropSession(sessionId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiBaseUrl}/api/mesh-editor/${sessionId}`);
  }

  getState(sessionId: number): Observable<MeshStateDto> {
    return this.http.get<MeshStateDto>(this.url(sessionId, 'state'));
  }

  // `shape`: a designed cube to start from (the unit cube when absent).
  // `cell`: the lattice cell to start in (0, 0, 0 when absent).
  addFirstHex(sessionId: number, shape?: MeshShapeDto, cell?: { i: number; j: number; k: number }): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'hexes/first'), { ...(shape ? { shape } : {}), ...(cell ? { cell } : {}) });
  }

  // `shape`: a designed cube, fitted onto the face (a plain extrusion of the face when absent).
  addHexOnFace(sessionId: number, hexId: number, face: HexFaceName, shape?: MeshShapeDto): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}/faces/${face}/attach`), shape ? { shape } : {});
  }

  // The cube constructor's calls are not tied to a session: a shape is designed first.
  shapePresets(): Observable<MeshShapePresetDto[]> {
    return this.http.get<MeshShapePresetDto[]>(`${environment.apiBaseUrl}/api/mesh-editor/shapes/presets`);
  }

  buildShape(parameters: MeshShapeParametersDto): Observable<MeshShapeDto> {
    return this.http.post<MeshShapeDto>(`${environment.apiBaseUrl}/api/mesh-editor/shapes/parametric`, parameters);
  }

  templateLibrary(): Observable<MeshTemplateLibraryDto> {
    return this.http.get<MeshTemplateLibraryDto>(`${environment.apiBaseUrl}/api/mesh-editor/shapes/templates`);
  }

  previewTemplate(request: MeshTemplateRequestDto): Observable<MeshTemplatePreviewDto> {
    return this.http.post<MeshTemplatePreviewDto>(`${environment.apiBaseUrl}/api/mesh-editor/shapes/templates/preview`, request);
  }

  // Adds a template body (pipe, sphere...) to the session as a separate part.
  addTemplate(sessionId: number, request: MeshTemplateRequestDto): Observable<MeshCommandResultDto> {
    return this.http.post<MeshCommandResultDto>(this.url(sessionId, 'bodies'), request);
  }

  checkShape(shape: MeshShapeDto): Observable<MeshShapeCheckDto> {
    return this.http.post<MeshShapeCheckDto>(`${environment.apiBaseUrl}/api/mesh-editor/shapes/check`, shape);
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

  removeHex(sessionId: number, hexId: number): Observable<MeshCommandResultDto> {
    return this.http.delete<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}`));
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

  // Moves a whole face by one displacement { dx, dy, dz }: the 8 face nodes fully,
  // the midpoints of the edges joining it to the opposite face by half (one undo step).
  moveFace(sessionId: number, hexId: number, face: HexFaceName, delta: MeshPointDto): Observable<MeshCommandResultDto> {
    return this.http.put<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}/faces/${face}/move`), { dx: delta.x, dy: delta.y, dz: delta.z });
  }

  // Moves a whole edge (index 0..11 of the cube's edges) by one displacement: its 2 corners and midpoint fully, the midpoints of the edges leaving the corners by half.
  moveEdge(sessionId: number, hexId: number, edge: number, delta: MeshPointDto): Observable<MeshCommandResultDto> {
    return this.http.put<MeshCommandResultDto>(this.url(sessionId, `hexes/${hexId}/edges/${edge}/move`), { dx: delta.x, dy: delta.y, dz: delta.z });
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
