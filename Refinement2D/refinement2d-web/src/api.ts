// What Refinement2D.Api sends and takes (see Program.cs there).
export interface CellDto { id: number; nodes: number[]; root: number }
export interface RootDto { id: number; i: number; j: number }
export interface AppliedDto { cell: number; template: string; index: number; children: number[] }
export interface PassDto { axis: number; n: number; marked: number[]; unreached: number[]; applied: AppliedDto[] }

export interface StateDto {
  scale: number;
  nodes: [number, number][];
  cells: CellDto[];
  roots: RootDto[];
  problems: string[];
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
