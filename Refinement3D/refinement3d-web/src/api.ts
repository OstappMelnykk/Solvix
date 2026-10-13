// What Refinement3D.Api sends and takes (see Program.cs there).
export interface CellDto { id: number; nodes: number[]; root: number }
export interface RootDto { id: number; i: number; j: number; k: number }
export interface AppliedDto { cell: number; template: string; index: number; children: number[] }
export interface PassDto { axis: number; n: number; marked: number[]; unreached: number[]; applied: AppliedDto[] }

export interface MeshDto {
  scale: number;
  positions?: number[] | null;                           // x, y, z of every node in units of the coarse grid, when the mesh has been smoothed
  nodes: [number, number, number][];
  cells: CellDto[];
  roots: RootDto[];
  problems: string[];
}

export interface QualityDto { min: number; mean: number; poor: number; inverted: number; cells: number; minScaled: number; meanScaled: number }

export interface StateDto extends MeshDto {
  quality: QualityDto;
  qualityBefore: QualityDto | null;
  smoothed: { moved: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  passes: PassDto[] | null;
}

export async function getState(): Promise<StateDto> {
  return (await fetch('/api/state')).json();
}

// A request that may be refused: the answer is the new state, or the error (and the state as it stays).
export async function post(path: string, body: unknown): Promise<{ state: StateDto } | { error: string; state?: StateDto }> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  return response.ok ? { state: data as StateDto } : { error: String(data.error ?? response.status), state: data.state };
}

export interface SeamDto {
  cell: number;
  side: number;                                           // the face tried (0 or 1 of the axis of the pass)
  kind: 'guess' | 'change' | 'refused';
  faceNodes: number[];
  added: number[];
  cutAcross: boolean;
  uncut: number[];                                        // the cells of M still not cut across once this choice is made
}

// One stage of a refinement (Refiner.Preview): the mesh then, the marked nodes, the cells in M, what the templates did.
export interface StepDto {
  kind: 'start' | 'layers' | 'seam' | 'marks' | 'templates' | 'expand' | 'final';
  axis: number;
  n: number;
  mesh: MeshDto | null;                                   // null in a 'seam' stage: the mesh is that of the 'layers' stage before it
  marked: number[];
  m: number[];
  applied: AppliedDto[];
  unreached: number[];
  seam: SeamDto | null;
}

export async function preview(cells: number[], nI: number, nJ: number, nK: number, expandTransitions: boolean): Promise<{ steps: StepDto[] } | { error: string }> {
  const response = await fetch('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cells, nI, nJ, nK, expandTransitions }) });
  const data = await response.json();
  return response.ok ? (data as { steps: StepDto[] }) : { error: String(data.error ?? response.status) };
}

// One cube divided by one template (T1: a corner marked, T2: an edge, T4: a face).
export async function templateOf(kind: string, n: number): Promise<{ mesh: MeshDto; marked: number[]; children: number } | { error: string }> {
  const response = await fetch(`/api/template?kind=${kind}&n=${n}`);
  const data = await response.json();
  return response.ok ? data : { error: String(data.error ?? response.status) };
}
