import { TestBed } from '@angular/core/testing';
import { DEFAULT_BODY_OPACITY, GeometryOpacityService, MIN_BODY_OPACITY } from './geometry-opacity.service';
import { IDEAL_WORLD_INDEX, QUALITY_WORLD_INDEX, REAL_WORLD_INDEX, SOLVER_WORLD_INDEX } from '../config/app-settings';

describe('GeometryOpacityService', () => {
  let opacity: GeometryOpacityService;

  beforeEach(() => {
    opacity = TestBed.inject(GeometryOpacityService);
  });

  it('is one opacity for the body in the Ideal, the Real and the Quality World, solid in the Solver World', () => {
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(DEFAULT_BODY_OPACITY);

    opacity.set(1, REAL_WORLD_INDEX, 0.4);
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(0.4);              // a slider in one World moves it for the others
    expect(opacity.get(1, QUALITY_WORLD_INDEX)).toBe(0.4);
    expect(opacity.get(1, SOLVER_WORLD_INDEX)).toBe(1);               // the Solver World has its own
    expect(opacity.get(2, IDEAL_WORLD_INDEX)).toBe(DEFAULT_BODY_OPACITY);   // and another session its own
  });

  it('keeps the value between the lowest and a solid body, ignores what is not a number, and forgets a session', () => {
    opacity.set(1, IDEAL_WORLD_INDEX, 9);
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(1);
    opacity.set(1, IDEAL_WORLD_INDEX, 0);
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(MIN_BODY_OPACITY);
    opacity.set(1, IDEAL_WORLD_INDEX, NaN);
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(MIN_BODY_OPACITY);
    opacity.set(1, SOLVER_WORLD_INDEX, 0.3);                           // not the body's
    expect(opacity.get(1, SOLVER_WORLD_INDEX)).toBe(1);

    opacity.forget(1);
    expect(opacity.get(1, IDEAL_WORLD_INDEX)).toBe(DEFAULT_BODY_OPACITY);
  });
});
