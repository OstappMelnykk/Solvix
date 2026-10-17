import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { MeshEditorApiService } from '../api/mesh-editor-api.service';
import { NotificationService } from './notification.service';

export interface ShellExportResult {
  readonly triangles: number;
  readonly faces: number;
  // The largest distance between a flat triangle and the curved surface it samples, in model units.
  readonly deviation: number;
}

// The outer skin of the body as an STL file: the server cuts every outer face into density x density squares on the real (curved) surface and the browser saves
// what comes back.
@Injectable({ providedIn: 'root' })
export class ShellExportService {
  private readonly api = inject(MeshEditorApiService);
  private readonly notifications = inject(NotificationService);

  readonly densities = [2, 4, 8, 16, 32, 64];

  // The trailing "done" is for the caller to refresh its busy state.
  save(sessionId: number, density: number, done: (result: ShellExportResult | null) => void, fileName = 'solvix-shell.stl'): void {
    this.api.exportShell(sessionId, density).subscribe({
      next: response => {
        const result = this.read(response);
        if (response.body) this.download(response.body, fileName);
        done(result);
      },
      error: (error: HttpErrorResponse) => {
        this.notifications.warning('Оболонку не експортовано: у сітці немає кубів або густота поза межами.');
        done(null);
      }
    });
  }

  private read(response: HttpResponse<Blob>): ShellExportResult {
    const header = (name: string) => Number(response.headers.get(name) ?? 'NaN');
    return { triangles: header('X-Shell-Triangles'), faces: header('X-Shell-Faces'), deviation: header('X-Shell-Deviation') };
  }

  private download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
