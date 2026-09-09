import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { VoxelGridDto, fromVoxelGridBinary } from '../geometry/voxel-grid-contract';

// Solvix.Api's 400 body for MeshTooLargeException, shape:
// { cellCount, limit } (ASP.NET Core's default camelCase JSON).
export interface VoxelizationTooLargeError {
  readonly cellCount: number;
  readonly limit: number;
}

// Mesh-building tool's slice of Solvix.Api - see CadWorkspaceApiService's
// header comment for why this is its own service rather than a method on
// that one (one service per toolbar tool that talks to the backend).
@Injectable({ providedIn: 'root' })
export class MeshApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/api/meshes`;
  // MeshesController's [Consumes("application/octet-stream")] expects the
  // binary layout geometry/mesh-contract.ts's toMeshBinary produces, not
  // JSON - Angular's HttpClient can't infer a Content-Type for a raw
  // ArrayBuffer body on its own, so this has to be set explicitly.
  private readonly binaryHeaders = new HttpHeaders({ 'Content-Type': 'application/octet-stream' });

  // responseType 'arraybuffer' - the success body is
  // geometry/voxel-grid-contract.ts's binary grid+bitmask format, not
  // JSON (see that file for why). Decoded here so callers never see a raw
  // ArrayBuffer.
  voxelize(mesh: ArrayBuffer): Observable<VoxelGridDto> {
    return this.http
      .post(`${this.baseUrl}/voxelize`, mesh, { headers: this.binaryHeaders, responseType: 'arraybuffer' })
      .pipe(map(fromVoxelGridBinary));
  }
}

// Because voxelize() asks for an arraybuffer responseType, Angular does
// NOT auto-parse an error response's body as JSON even though the server
// sent one (that auto-parsing only kicks in for the default 'json'
// responseType) - `response.error` on the too-large case is itself an
// ArrayBuffer holding the UTF-8 JSON text, so it has to be decoded by hand.
// Returns null for any other error shape (network failure, 500, etc.).
export function parseVoxelizationTooLargeError(response: HttpErrorResponse): VoxelizationTooLargeError | null {
  if (!(response.error instanceof ArrayBuffer)) {
    return null;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(response.error)) as { cellCount?: unknown; limit?: unknown };
    if (typeof body.cellCount !== 'number' || typeof body.limit !== 'number') {
      return null;
    }
    return { cellCount: body.cellCount, limit: body.limit };
  } catch {
    return null;
  }
}