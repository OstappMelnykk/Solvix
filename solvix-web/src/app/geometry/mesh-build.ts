import { HexFaceName } from '../api/mesh-editor-api.service';
import { GroundCell } from './ground-cell';
import { MeshPick } from './mesh-editor-view';

// What a click while building with the mouse asks of the mesh: a right click adds, a left click removes.
export type BuildCommand =
  | { readonly kind: 'removeHex'; readonly hex: number }
  | { readonly kind: 'addOnFace'; readonly hex: number; readonly face: HexFaceName }
  | { readonly kind: 'addFirst'; readonly cell: GroundCell };

export interface BuildClick {
  readonly action: 'add' | 'remove';
  readonly pick: MeshPick | null;
  readonly ground: GroundCell | null;
}

//  - left click on a cube: that cube is removed (the server refuses a removal that would split the body);
//  - right click on a face of a cube: a cube is added on that face;
//  - right click on the ground with no cubes yet: the first cube, in that cell of the lattice;
//  - anything else (a node, empty space, the ground when there are cubes already): nothing.
export function buildCommandFor(click: BuildClick, hexCount: number): BuildCommand | null {
  const face = click.pick?.kind === 'face' ? click.pick : null;
  if (click.action === 'remove') return face ? { kind: 'removeHex', hex: face.hex } : null;
  if (face) return { kind: 'addOnFace', hex: face.hex, face: face.face };
  if (click.ground && hexCount === 0) return { kind: 'addFirst', cell: click.ground };
  return null;
}
