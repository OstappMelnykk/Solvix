import { ElementFaceRefDto, SolverMeshDto } from '../api/solver-api.service';
import { PickedFace } from './mesh-editor-view';
import { Scope } from './solver-targets';

// What a click on a mesh of finite elements (a locally refined body) acts on, worked out from the face that was hit. Faces and elements are named
// by key, never by a cell of a grid, so a small face next to a big one is just as reachable. Pure functions, as the cell-based ones in solver-targets.

// How far a click reaches in such a mesh: the face / element itself, the whole cube it lies in, or (faces) every surface face on that side.
export const FEM_FACE_SCOPES: readonly Scope[] = ['cell', 'cube', 'side'];
export const FEM_MATERIAL_SCOPES: readonly Scope[] = ['cell', 'cube'];

export interface FemIndex {
  readonly element: ReadonlyMap<string, number>;
}

export function femIndex(mesh: SolverMeshDto): FemIndex {
  return { element: new Map(mesh.keys.map((key, i) => [key, i])) };
}

// What a hover or a stroke has reached, for the highlight.
export interface FemHighlightInput {
  readonly faces: readonly ElementFaceRefDto[];
  readonly elements: readonly string[];
  readonly pointed: ElementFaceRefDto | null;
}

export function isFemPick(pick: PickedFace | null): pick is PickedFace & { elementKey: string; localFace: number } {
  return pick !== null && pick.elementKey !== undefined && pick.localFace !== undefined;
}

function surfaceFaces(mesh: SolverMeshDto): ElementFaceRefDto[] {
  const faces: ElementFaceRefDto[] = [];
  for (let i = 0; i + 1 < mesh.surfaceFaces.length; i += 2) faces.push({ key: mesh.keys[mesh.surfaceFaces[i]], face: mesh.surfaceFaces[i + 1] });
  return faces;
}

// Faces to clamp or press: the one hit, every surface face on that side of its cube, or every surface face on that side of any cube.
export function femFaceTargets(pick: PickedFace, scope: Scope, mesh: SolverMeshDto, index: FemIndex): ElementFaceRefDto[] {
  if (!isFemPick(pick)) return [];
  const one = { key: pick.elementKey, face: pick.localFace };
  if (scope === 'cell' || (scope !== 'cube' && scope !== 'side')) return [one];
  const hex = pick.hex;
  return surfaceFaces(mesh).filter(f => f.face === pick.localFace && (scope === 'side' || mesh.hexIds[index.element.get(f.key) ?? -1] === hex));
}

// Elements to give a material: the one behind the face hit, or all of its cube.
export function femElementTargets(pick: PickedFace, scope: Scope, mesh: SolverMeshDto): string[] {
  if (!isFemPick(pick)) return [];
  if (scope !== 'cube') return [pick.elementKey];
  return mesh.keys.filter((_, i) => mesh.hexIds[i] === pick.hex);
}

// Whether every one of these faces is already clamped, or already pressed with this pressure (then a click takes the mark off).
export function femAllMarked(mesh: SolverMeshDto, index: FemIndex, faces: readonly ElementFaceRefDto[], mark: 'fixed' | 'loaded', pressure = 0): boolean {
  if (faces.length === 0) return false;
  const marked = new Map<number, number>();
  const list = mark === 'fixed' ? mesh.fixedFaces : mesh.loadedFaces;
  for (let i = 0; i + 1 < list.length; i += 2) marked.set(list[i] * 6 + list[i + 1], mark === 'loaded' ? (mesh.pressures[i / 2] ?? 0) : 0);
  return faces.every(f => {
    const e = index.element.get(f.key);
    if (e === undefined) return false;
    const id = e * 6 + f.face;
    return marked.has(id) && (mark === 'fixed' || marked.get(id) === pressure);
  });
}
