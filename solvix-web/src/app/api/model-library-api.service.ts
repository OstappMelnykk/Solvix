import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Mirrors Solvix.Api's ModelLibraryEntryDto (ModelLibraryController.cs) -
// ASP.NET Core's default camelCase JSON serialization.
export interface ModelLibraryEntryDto {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
}

// The server-side model library's slice of Solvix.Api - list what's already
// there, upload a locally-picked file into it, and download one entry's
// bytes back out (fed through ModelImportService.loadFromFile the same way
// a local <input type="file"> pick is, once wrapped back into a File by the
// caller - this service only ever deals in raw bytes/DTOs).
@Injectable({ providedIn: 'root' })
export class ModelLibraryApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/api/model-library`;
  // Same reasoning as MeshApiService's binaryHeaders - Angular can't infer a
  // Content-Type for a raw ArrayBuffer body, and
  // ModelLibraryController.Upload is [Consumes("application/octet-stream")].
  private readonly binaryHeaders = new HttpHeaders({ 'Content-Type': 'application/octet-stream' });

  list(): Observable<ModelLibraryEntryDto[]> {
    return this.http.get<ModelLibraryEntryDto[]>(this.baseUrl);
  }

  // `fileName` travels as a query param (not inferred from Content-Type)
  // since ModelLibraryController.Upload accepts more than one format - see
  // that controller's [FromQuery] string fileName.
  upload(fileName: string, content: ArrayBuffer): Observable<ModelLibraryEntryDto> {
    const params = new HttpParams().set('fileName', fileName);
    return this.http.post<ModelLibraryEntryDto>(this.baseUrl, content, { headers: this.binaryHeaders, params });
  }

  download(id: string): Observable<ArrayBuffer> {
    return this.http.get(`${this.baseUrl}/${id}`, { responseType: 'arraybuffer' });
  }
}
