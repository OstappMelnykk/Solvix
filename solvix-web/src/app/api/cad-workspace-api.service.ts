import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

// Everything the CAD workspace (icon 0 - CadWorkspaceComponent and what's
// under it) needs from Solvix.Api goes here - one service per toolbar tool
// that actually talks to the backend, mirroring WORKSPACE_VIEWS: each tool
// owns its own slice of both UI and API surface, so a future "Mesh" or
// "Solver" tool gets its own MeshApiService/SolverApiService instead of
// this one growing unrelated methods.
//
// No methods yet on purpose: Solvix.Api currently exposes zero endpoints
// (Program.cs never calls app.MapControllers(), IMeshBuilderFacade/
// ISolverFacade are empty interfaces) - this is the seam where the actual
// HttpClient calls go once a real endpoint exists to call.
@Injectable({ providedIn: 'root' })
export class CadWorkspaceApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/api/cad`;
}