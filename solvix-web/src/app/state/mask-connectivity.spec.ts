import { labelConnectedComponents } from './mask-connectivity';

describe('labelConnectedComponents', () => {
  it('labels an empty mask with zero components', () => {
    const mask = new Uint8Array(9); // 3x3, all unset
    const { labels, componentCount } = labelConnectedComponents(mask, 3, 3);

    expect(componentCount).toBe(0);
    expect(Array.from(labels)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it('labels one connected blob as a single component', () => {
    // 3x1: [1, 1, 1]
    const mask = new Uint8Array([1, 1, 1]);
    const { labels, componentCount } = labelConnectedComponents(mask, 3, 1);

    expect(componentCount).toBe(1);
    expect(Array.from(labels)).toEqual([0, 0, 0]);
  });

  it('labels 2 disconnected islands with different component ids', () => {
    // 3x1: [1, 0, 1] - a gap at u=1 splits it into 2 islands
    const mask = new Uint8Array([1, 0, 1]);
    const { labels, componentCount } = labelConnectedComponents(mask, 3, 1);

    expect(componentCount).toBe(2);
    expect(labels[0]).not.toBe(labels[2]);
    expect(labels[1]).toBe(-1);
  });

  it('merges into one component once a bridging cell connects 2 islands', () => {
    const mask = new Uint8Array([1, 1, 1]); // bridged
    const { componentCount } = labelConnectedComponents(mask, 3, 1);

    expect(componentCount).toBe(1);
  });

  it('only 4-connects (a diagonal touch does not merge 2 islands)', () => {
    // 2x2: (0,0) and (1,1) set, diagonal to each other - not 4-connected.
    const mask = new Uint8Array([1, 0, 0, 1]);
    const { labels, componentCount } = labelConnectedComponents(mask, 2, 2);

    expect(componentCount).toBe(2);
    expect(labels[0]).not.toBe(labels[3]);
  });
});
