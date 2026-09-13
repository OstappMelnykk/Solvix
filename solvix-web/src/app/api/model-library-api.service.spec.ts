import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../environments/environment';
import { ModelLibraryApiService, ModelLibraryEntryDto } from './model-library-api.service';

describe('ModelLibraryApiService', () => {
  let api: ModelLibraryApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    api = TestBed.inject(ModelLibraryApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('GETs the entry list as JSON', () => {
    const dto: ModelLibraryEntryDto = { id: 'abc', fileName: 'tooth.stl', sizeBytes: 123, uploadedAt: '2026-09-13T00:00:00Z' };

    let received: ModelLibraryEntryDto[] | undefined;
    api.list().subscribe(result => (received = result));

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/model-library`);
    expect(request.request.method).toBe('GET');
    request.flush([dto]);

    expect(received).toEqual([dto]);
  });

  it('POSTs the raw bytes with fileName as a query param', () => {
    const bytes = new ArrayBuffer(4);
    const dto: ModelLibraryEntryDto = { id: 'abc', fileName: 'tooth.stl', sizeBytes: 4, uploadedAt: '2026-09-13T00:00:00Z' };

    let received: ModelLibraryEntryDto | undefined;
    api.upload('tooth.stl', bytes).subscribe(result => (received = result));

    const request = httpMock.expectOne(request => request.url === `${environment.apiBaseUrl}/api/model-library`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBe(bytes);
    expect(request.request.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(request.request.params.get('fileName')).toBe('tooth.stl');

    request.flush(dto);
    expect(received).toEqual(dto);
  });

  it('GETs an entry\'s raw bytes by id', () => {
    const bytes = new ArrayBuffer(8);

    let received: ArrayBuffer | undefined;
    api.download('abc').subscribe(result => (received = result));

    const request = httpMock.expectOne(`${environment.apiBaseUrl}/api/model-library/abc`);
    expect(request.request.method).toBe('GET');
    expect(request.request.responseType).toBe('arraybuffer');

    request.flush(bytes);
    expect(received).toBe(bytes);
  });
});
