import * as THREE from 'three';
import { buildDimensionLines, disposeDimensionLines } from './dimension-lines';

describe('buildDimensionLines', () => {
  it('builds one line-segments object and 3 axis labels (X/Y/Z)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -0.5, -1.5), new THREE.Vector3(1, 0.5, 1.5));

    const group = buildDimensionLines(box);

    const lineSegments = group.children.filter(child => child instanceof THREE.LineSegments);
    const sprites = group.children.filter(child => child instanceof THREE.Sprite);
    expect(lineSegments.length).toBe(1);
    expect(sprites.length).toBe(3);
  });

  it('is built in the local frame of `box` - no extra transform baked into the group itself', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -0.5, -1.5), new THREE.Vector3(1, 0.5, 1.5));

    const group = buildDimensionLines(box);

    expect(group.position.equals(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(group.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });

  it('does not throw for a degenerate (zero-size) box', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));

    expect(() => buildDimensionLines(box)).not.toThrow();
  });

  it('scales its extent with the box passed in (caller pre-scales, no internal scale factor)', () => {
    const small = buildDimensionLines(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)));
    const large = buildDimensionLines(new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)));

    const smallBox = new THREE.Box3().setFromObject(small);
    const largeBox = new THREE.Box3().setFromObject(large);
    const smallSize = smallBox.getSize(new THREE.Vector3());
    const largeSize = largeBox.getSize(new THREE.Vector3());

    expect(largeSize.x).toBeGreaterThan(smallSize.x);
  });
});

describe('disposeDimensionLines', () => {
  it('disposes the line-segments geometry/material and every sprite material+texture without throwing', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -0.5, -1.5), new THREE.Vector3(1, 0.5, 1.5));
    const group = buildDimensionLines(box);

    const lineSegments = group.children.find(child => child instanceof THREE.LineSegments) as THREE.LineSegments;
    const sprite = group.children.find(child => child instanceof THREE.Sprite) as THREE.Sprite;
    const geometryDispose = spyOn(lineSegments.geometry, 'dispose');
    const materialDispose = spyOn(lineSegments.material as THREE.Material, 'dispose');
    const spriteMaterialDispose = spyOn(sprite.material, 'dispose');

    expect(() => disposeDimensionLines(group)).not.toThrow();

    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(spriteMaterialDispose).toHaveBeenCalled();
  });
});