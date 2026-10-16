import { MAX_NODE_SIZE, MIN_NODE_SIZE, NodeSizeService } from './node-size.service';

describe('NodeSizeService', () => {
  const service = new NodeSizeService();

  it('starts at the usual size, per session', () => {
    expect(service.get(1)).toBe(1);
    service.set(1, 2);
    expect(service.get(1)).toBe(2);
    expect(service.get(2)).toBe(1);
  });

  it('keeps the size within its limits and ignores junk', () => {
    service.set(3, 100);
    expect(service.get(3)).toBe(MAX_NODE_SIZE);
    service.set(3, 0);
    expect(service.get(3)).toBe(MIN_NODE_SIZE);
    service.set(3, NaN);
    expect(service.get(3)).toBe(MIN_NODE_SIZE);
  });

  it('forgets a session that is gone', () => {
    service.set(4, 2);
    service.forget(4);
    expect(service.get(4)).toBe(1);
  });
});
