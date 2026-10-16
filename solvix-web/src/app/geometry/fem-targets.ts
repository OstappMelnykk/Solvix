import { ElementFaceRefDto, SolverMeshDto } from '../api/solver-api.service';
import { HexFaceName } from '../api/mesh-editor-api.service';
import { PickedFace, faceSlots } from './mesh-editor-view';
import { Scope } from './solver-targets';

// What a click on a mesh of finite elements (a locally refined body) acts on, worked out from the face that was hit. Faces and elements are named
// by key, never by a cell of a grid, so a small face next to a big one is just as reachable. Pure functions, as the cell-based ones in solver-targets.

// How far a click reaches in such a mesh: the face / element itself, the whole cube it lies in, or (faces) every surface face on that side.
export const FEM_FACE_SCOPES: readonly Scope[] = ['cell', 'cube', 'side'];
export const FEM_MATERIAL_SCOPES: readonly Scope[] = ['cell', 'cube'];
// Elements to refine: one, the row of them inward through the body from the face, or the whole cube.
export const FEM_REFINE_SCOPES: readonly Scope[] = ['cell', 'column', 'cube'];

export interface FemIndex {
  readonly element: ReadonlyMap<string, number>;
  // The faces (element * 6 + local face) that have the same four corner nodes: a face inside the body belongs to two elements, one on the surface to one.
  readonly sharing: ReadonlyMap<string, readonly number[]>;
}

// The corner slots (0..7) of each local face, the solver's order: ZMinus, ZPlus, YMinus, YPlus, XMinus, XPlus.
const FACE_CORNERS: readonly (readonly number[])[] = ['ZMinus', 'ZPlus', 'YMinus', 'YPlus', 'XMinus', 'XPlus'].map(name => faceSlots(name as HexFaceName).filter(slot => slot < 8));

export function cornerKey(mesh: SolverMeshDto, element: number, face: number): string {
  return FACE_CORNERS[face].map(slot => mesh.connectivity[element * 20 + slot]).sort((a, b) => a - b).join(',');
}

export function femIndex(mesh: SolverMeshDto): FemIndex {
  const sharing = new Map<string, number[]>();
  if ((mesh.connectivity?.length ?? 0) >= 20 * mesh.keys.length) {
    for (let e = 0; e < mesh.keys.length; e++)
      for (let face = 0; face < 6; face++) {
        const key = cornerKey(mesh, e, face);
        const list = sharing.get(key);
        if (list) list.push(e * 6 + face);
        else sharing.set(key, [e * 6 + face]);
      }
  }
  return { element: new Map(mesh.keys.map((key, i) => [key, i])), sharing };
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

// Elements to refine: the one behind the face hit, the whole row of them from that face inward through the body, or every leaf of its cube.
export function femRefineTargets(pick: PickedFace, scope: Scope, mesh: SolverMeshDto, index: FemIndex): string[] {
  if (!isFemPick(pick)) return [];
  if (scope === 'cube') return femElementTargets(pick, 'cube', mesh);
  if (scope !== 'column') return [pick.elementKey];
  const keys: string[] = [];
  let element = index.element.get(pick.elementKey);
  let face = pick.localFace;
  while (element !== undefined && keys.length < mesh.keys.length) {
    const here: number = element;
    keys.push(mesh.keys[here]);
    // through the opposite face to whatever shares it
    const out = face ^ 1;
    const next = (index.sharing.get(cornerKey(mesh, here, out)) ?? []).find(id => id !== here * 6 + out);
    if (next === undefined) break;
    element = Math.floor(next / 6);
    face = next % 6;
  }
  return keys;
}
