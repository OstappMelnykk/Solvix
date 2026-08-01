import { KeyedStore } from './keyed-store';

describe('KeyedStore', () => {
  it('getOrCreate creates once and reuses the same value afterward', () => {
    const store = new KeyedStore<number, { n: number }>();
    let created = 0;
    const factory = () => {
      created++;
      return { n: created };
    };

    const first = store.getOrCreate(1, factory);
    const second = store.getOrCreate(1, factory);

    expect(created).toBe(1);
    expect(second).toBe(first);
  });

  it('get/set/delete behave like a plain map', () => {
    const store = new KeyedStore<string, number>();
    expect(store.get('a')).toBeUndefined();

    store.set('a', 1);
    expect(store.get('a')).toBe(1);

    store.delete('a');
    expect(store.get('a')).toBeUndefined();
  });

  it('pruneTo drops entries not in the valid key set and keeps the rest', () => {
    const store = new KeyedStore<number, string>();
    store.set(1, 'a');
    store.set(2, 'b');
    store.set(3, 'c');

    store.pruneTo([1, 3]);

    expect(store.get(1)).toBe('a');
    expect(store.get(2)).toBeUndefined();
    expect(store.get(3)).toBe('c');
  });

  it('pruneTo calls onRemove only for entries actually removed', () => {
    const store = new KeyedStore<number, string>();
    store.set(1, 'a');
    store.set(2, 'b');
    const removed: Array<[string, number]> = [];

    store.pruneTo([1], (value, key) => removed.push([value, key]));

    expect(removed).toEqual([['b', 2]]);
  });
});