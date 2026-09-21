import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BoundaryEdge } from '../watertight-check';

// Bright, unmissable color for exactly the boundary edges a hole punches
// into an otherwise-closed surface - deliberately far from every other
// color already in use nearby (the reference's own material, the voxel
// wireframe's white, the disconnected-zone-island reds/oranges/purples), so
// "this is a defect" reads at a glance.
const OUTLINE_COLOR = 0xff2d55;
// CSS pixels (LineMaterial's `worldUnits` defaults to false) - a constant
// on-screen thickness regardless of zoom/distance, same reasoning as
// floor-grid.ts's own LINE_WIDTH_PX: a hole can be a small feature on a
// large model, so a "thin" line has to mean thin IN SCREEN SPACE. A plain
// LineBasicMaterial's `linewidth` is a documented no-op on nearly every
// browser/GPU - it always renders at a fixed ~1 DEVICE pixel no matter how
// far the camera is, which read as "the hole disappeared" when zoomed to a
// normal viewing distance and "a noisy tangle" when zoomed in close enough
// that 1 device pixel started covering multiple edges at once. Fat lines
// (LineSegments2/LineMaterial) draw a real screen-space quad per segment
// instead, so this stays a crisp, constant-width line at any zoom.
const OUTLINE_WIDTH_PX = 2;

// A translucent film over the fan-triangulated interior of each hole loop -
// a hole IS a missing polygon, not just a rim around one, so on top of the
// precise boundary outline this fills in the actual missing area. Fan-from-
// centroid rather than a real polygon triangulation: a real STL hole
// boundary is rarely perfectly planar or convex, so this is an
// approximation, but it only needs to visually read as "the surface is
// missing here", not stand in as a real repair patch.
const FILL_COLOR = 0xff2d55;
const FILL_OPACITY = 0.45;

// A constant-SCREEN-size marker at each hole's centroid, on top of the
// precise outline+fill above - those are both real 3D geometry, so at a
// normal "look at the whole model" distance a small hole still shrinks down
// to a barely-there sliver, exactly the "can't tell where it is from far
// away" complaint this exists to fix. `sizeAttenuation: false` makes a
// Sprite's scale independent of camera distance (unlike dimension-lines.ts's
// own label Sprite, which deliberately DOES shrink with the model), and
// `depthTest: false` keeps it visible even through the model's own opaque
// surface - both together mean this marker reads the same from any
// distance or angle, closer to a map pin than a piece of the geometry.
const MARKER_TEXTURE_SIZE = 64;
const MARKER_SCALE = 0.05;

// A fresh texture per buildHoleHighlight call (not a module-level singleton)
// so disposeHoleHighlight can dispose it along with everything else this
// call created, with no lifetime question about whether some OTHER still-
// live highlight object is also using it - it's tiny (64x64) and only
// rebuilt on a density/rotation/reimport change, never per frame.
function buildMarkerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = MARKER_TEXTURE_SIZE;
  canvas.height = MARKER_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d')!;
  const center = MARKER_TEXTURE_SIZE / 2;
  ctx.beginPath();
  ctx.arc(center, center, center - 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ff2d55';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${MARKER_TEXTURE_SIZE * 0.6}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', center, center + 2);
  return new THREE.CanvasTexture(canvas);
}

function buildHoleMarker(position: THREE.Vector3, texture: THREE.CanvasTexture): THREE.Sprite {
  const material = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(position);
  sprite.scale.setScalar(MARKER_SCALE);
  sprite.renderOrder = 7;
  // Named so a caller (WorldCanvasComponent's own holeMarkersVisible toggle)
  // can find and hide just the markers without touching the outline/fill.
  sprite.name = 'hole-highlight-marker';
  return sprite;
}

function buildHoleFillGeometry(loops: readonly (readonly THREE.Vector3[])[]): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const centroid = new THREE.Vector3();
  for (const loop of loops) {
    if (loop.length < 3) {
      continue;
    }
    centroid.set(0, 0, 0);
    loop.forEach(point => centroid.add(point));
    centroid.divideScalar(loop.length);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      positions.push(centroid.x, centroid.y, centroid.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  if (positions.length === 0) {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Unlike voxels.ts's own edge wireframe (which reverted this exact fat-line
// technique because ITS geometry is shared across SEVERAL renderers at once
// with different resolutions - six-view, zone painting, and the main canvas
// simultaneously), this object has no such conflict: RenderWindowComponent
// only ever hands it to the ONE Ideal-World WorldCanvasComponent (every
// other world gets null), and that same component's own previewFixtures()
// hides it whenever six-view or zone-painting opens (openSixView/
// openZonePainting both pass previewFixtures() as hiddenDuringView) - so
// exactly one renderer ever actually draws this, exactly like the floor
// grid. updateHoleHighlightResolution below is that renderer's own
// checkResize feeding this the ONE resolution it will ever need.
export function buildHoleHighlight(
  edges: readonly BoundaryEdge[],
  loops: readonly (readonly THREE.Vector3[])[],
  clusters: readonly (readonly THREE.Vector3[])[]
): THREE.Object3D | null {
  if (edges.length === 0) {
    return null;
  }

  const group = new THREE.Group();
  group.name = 'hole-highlight';

  const outlinePositions: number[] = [];
  edges.forEach(edge => {
    outlinePositions.push(edge.a.x, edge.a.y, edge.a.z, edge.b.x, edge.b.y, edge.b.z);
  });
  const outlineGeometry = new LineSegmentsGeometry();
  outlineGeometry.setPositions(outlinePositions);
  const outlineMaterial = new LineMaterial({ color: OUTLINE_COLOR, linewidth: OUTLINE_WIDTH_PX, depthTest: false });
  const outline = new LineSegments2(outlineGeometry, outlineMaterial);
  outline.computeLineDistances();
  outline.renderOrder = 6;
  outline.name = 'hole-highlight-outline';
  group.add(outline);

  const fillGeometry = buildHoleFillGeometry(loops);
  if (fillGeometry) {
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: FILL_COLOR,
      transparent: true,
      opacity: FILL_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
      // Without this, the fill sits at almost the exact same depth as the
      // real surface it's patching over - the instant that surface is made
      // opaque (fully solid, not translucent), ordinary depth testing hides
      // the fill behind/inside it via z-fighting instead of drawing on top.
      // Every other piece of this highlight (outline, marker) already
      // ignores depth for the same "must stay visible no matter what the
      // rest of the scene is doing" reason.
      depthTest: false
    });
    const fill = new THREE.Mesh(fillGeometry, fillMaterial);
    fill.renderOrder = 5;
    group.add(fill);
  }

  // One marker per CLUSTER, not per loop - a cluster covers every red patch
  // the outline actually draws (including non-manifold seams and
  // branching/non-simple boundaries that findHoleBoundaryLoops has to leave
  // out of `loops` because they don't form a single closed simple polygon),
  // so nothing the outline highlights is ever left without its own marker.
  if (clusters.length > 0) {
    const markerTexture = buildMarkerTexture();
    const centroid = new THREE.Vector3();
    clusters.forEach(cluster => {
      if (cluster.length === 0) {
        return;
      }
      centroid.set(0, 0, 0);
      cluster.forEach(point => centroid.add(point));
      centroid.divideScalar(cluster.length);
      group.add(buildHoleMarker(centroid, markerTexture));
    });
  }

  return group;
}

// LineMaterial's line-width calculation needs the OWNING renderer's current
// CSS pixel size to convert `linewidth` into the right amount of screen-
// space quad extrusion (see floor-grid.ts's own updateGridResolution) - a
// no-op if `highlight` wasn't built by buildHoleHighlight (nothing to find),
// so callers can pass a possibly-null cached value through unconditionally.
export function updateHoleHighlightResolution(highlight: THREE.Object3D | null, width: number, height: number): void {
  const outline = highlight?.getObjectByName('hole-highlight-outline');
  if (outline instanceof LineSegments2) {
    (outline.material as LineMaterial).resolution.set(width, height);
  }
}

// Toggles just the marker pins on/off (ImportedReferenceDisplayService.holeMarkersVisible),
// leaving the precise outline/fill alone - the markers sit ON TOP of the
// geometry at a fixed screen size, which is exactly what makes them get in
// the way once the user zooms in close to actually inspect a hole.
export function setHoleMarkersVisible(highlight: THREE.Object3D | null, visible: boolean): void {
  highlight?.traverse(child => {
    if (child instanceof THREE.Sprite) {
      child.visible = visible;
    }
  });
}

export function disposeHoleHighlight(object: THREE.Object3D): void {
  // LineSegments2 is itself a THREE.Mesh subclass (three/examples/jsm/lines/LineSegments2.js),
  // so this one check already covers both it and the plain fill Mesh.
  const disposedMaterials = new Set<THREE.Material>();
  object.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const material = child.material as THREE.Material;
      if (!disposedMaterials.has(material)) {
        disposedMaterials.add(material);
        material.dispose();
      }
    } else if (child instanceof THREE.Sprite) {
      const material = child.material;
      if (!disposedMaterials.has(material)) {
        disposedMaterials.add(material);
        // Every marker sprite from one buildHoleHighlight call shares the
        // SAME buildMarkerTexture() result - disposing it once here (via
        // the FIRST sprite it's found on) covers all of them, matching how
        // dispose only ever runs on a whole highlight object at once.
        material.map?.dispose();
        material.dispose();
      }
    }
  });
}
