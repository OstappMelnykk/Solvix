import { HexFaceName, MeshStateDto } from '../api/mesh-editor-api.service';
import { SolverElementDto, SolverFaceDto } from '../api/solver-api.service';
import { PickedFace, faceAxis, faceSign } from './mesh-editor-view';

// What a click in the Solver World acts on, worked out from the small face that was hit. Pure functions, shared
// by the click itself (SolverService), the highlight drawn while hovering, and the tests.

// How far a click reaches. Faces (load, clamp): `cell` = the small face, `cube` = the whole side of the cube,
// `side` = every outer face with that name. Materials: `cell` = the small element at the chosen depth, `column` =
// all elements below the small face, `layer` = the slab of the cube at the chosen depth, `cube` = the whole cube.
export type Scope = 'cell' | 'column' | 'layer' | 'cube' | 'side';

export type Tool = 'view' | 'load' | 'fix' | 'material' | 'erase';

export const FACE_SCOPES: readonly Scope[] = ['cell', 'cube', 'side'];
export const MATERIAL_SCOPES: readonly Scope[] = ['cell', 'column', 'layer', 'cube'];

// The two tangent axes of a face, lower first - the (p, q) of a small face run along them.
export function tangentAxes(face: HexFaceName): [number, number] {
  const axis = faceAxis(face);
  const [a, b] = [0, 1, 2].filter(d => d !== axis);
  return [a, b];
}

// Small faces to mark: the one hit, all of its side of the cube, or every outer face with that name.
export function faceTargets(pick: PickedFace, scope: Scope, state: MeshStateDto | null, divisions: readonly number[]): SolverFaceDto[] {
  if (pick.p === undefined || pick.q === undefined) return [{ hex: pick.hex, face: pick.face }];
  if (scope === 'cell') return [{ hex: pick.hex, face: pick.face, p: pick.p, q: pick.q }];
  if (scope === 'cube') return [{ hex: pick.hex, face: pick.face }];
  const outer = (state?.faces ?? []).filter(f => f.face === pick.face && f.status !== 'Linked');
  return outer.length > 0 ? outer.map(f => ({ hex: f.hex, face: f.face })) : [{ hex: pick.hex, face: pick.face }];
}

// The element at `depth` steps inward from the face that was hit (0 = the element behind it), or null when that is
// outside the cube.
export function elementAtDepth(pick: PickedFace, depth: number, divisions: readonly number[]): [number, number, number] | null {
  if (!pick.element) return null;
  const axis = faceAxis(pick.face);
  const inward = faceSign(pick.face) < 0 ? 1 : -1;            // from a face on the minus side, inward is +axis
  const index = [...pick.element] as [number, number, number];
  index[axis] += inward * depth;
  return index[axis] >= 0 && index[axis] < divisions[axis] ? index : null;
}

// Small elements to give a material: by scope, below the small face that was hit.
export function elementTargets(pick: PickedFace, scope: Scope, depth: number, divisions: readonly number[]): SolverElementDto[] {
  if (!pick.element) return [];
  const axis = faceAxis(pick.face);
  const make = (index: readonly number[]): SolverElementDto => ({ hex: pick.hex, ex: index[0], ey: index[1], ez: index[2] });
  if (scope === 'cube') {
    const all: SolverElementDto[] = [];
    for (let z = 0; z < divisions[2]; z++) for (let y = 0; y < divisions[1]; y++) for (let x = 0; x < divisions[0]; x++) all.push(make([x, y, z]));
    return all;
  }
  if (scope === 'column') {
    const column: SolverElementDto[] = [];
    for (let d = 0; d < divisions[axis]; d++) {
      const index = elementAtDepth(pick, d, divisions);
      if (index) column.push(make(index));
    }
    return column;
  }
  const at = elementAtDepth(pick, depth, divisions);
  if (!at) return [];
  if (scope === 'layer') {
    const layer: SolverElementDto[] = [];
    const [t0, t1] = tangentAxes(pick.face);
    for (let i = 0; i < divisions[t0]; i++) {
      for (let j = 0; j < divisions[t1]; j++) {
        const index = [...at];
        index[t0] = i;
        index[t1] = j;
        layer.push(make(index));
      }
    }
    return layer;
  }
  return [make(at)];
}

// What the highlight draws: the small faces a click would mark, the elements it would give a material, and the small
// face under the mouse.
export interface HighlightTargetsInput {
  readonly faces: readonly SolverFaceDto[];
  readonly elements: readonly SolverElementDto[];
  readonly pointed: PickedFace | null;
}

export function sameFace(a: SolverFaceDto, b: SolverFaceDto): boolean {
  return a.hex === b.hex && a.face === b.face && (a.p ?? -1) === (b.p ?? -1) && (a.q ?? -1) === (b.q ?? -1);
}

// Every small face a (possibly whole-side) target stands for, at this division.
export function smallFacesOf(target: SolverFaceDto, divisions: readonly number[]): SolverFaceDto[] {
  if (target.p !== undefined && target.q !== undefined) return [target];
  const [t0, t1] = tangentAxes(target.face);
  const faces: SolverFaceDto[] = [];
  for (let p = 0; p < divisions[t0]; p++) for (let q = 0; q < divisions[t1]; q++) faces.push({ hex: target.hex, face: target.face, p, q });
  return faces;
}

