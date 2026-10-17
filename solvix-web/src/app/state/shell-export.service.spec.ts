import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { MeshEditorApiService } from '../api/mesh-editor-api.service';
import { NotificationService } from './notification.service';
import { ShellExportResult, ShellExportService } from './shell-export.service';

describe('ShellExportService', () => {
  let api: jasmine.SpyObj<MeshEditorApiService>;
  let notifications: jasmine.SpyObj<NotificationService>;
  let service: ShellExportService;

  beforeEach(() => {
    api = jasmine.createSpyObj('MeshEditorApiService', ['exportShell']);
    notifications = jasmine.createSpyObj('NotificationService', ['warning']);
    TestBed.configureTestingModule({ providers: [{ provide: MeshEditorApiService, useValue: api }, { provide: NotificationService, useValue: notifications }] });
    service = TestBed.inject(ShellExportService);
  });

  it('asks for the density, saves the file and reports what the server counted', () => {
    const headers = new HttpHeaders({ 'X-Shell-Triangles': '192', 'X-Shell-Faces': '6', 'X-Shell-Deviation': '0.0012' });
    api.exportShell.and.returnValue(of(new HttpResponse<Blob>({ body: new Blob(['x']), headers })));
    const clicked: string[] = [];
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    const results: (ShellExportResult | null)[] = [];

    service.save(3, 16, r => results.push(r), 'a.stl');

    expect(api.exportShell).toHaveBeenCalledWith(3, 16);
    expect(clicked).toEqual(['a.stl']);
    expect(results).toEqual([{ triangles: 192, faces: 6, deviation: 0.0012 }]);
  });

  it('warns and gives nothing back when the server refuses', () => {
    api.exportShell.and.returnValue(throwError(() => new HttpErrorResponse({ status: 400 })));
    const results: (ShellExportResult | null)[] = [];

    service.save(3, 8, r => results.push(r));

    expect(notifications.warning).toHaveBeenCalled();
    expect(results).toEqual([null]);
  });
});
