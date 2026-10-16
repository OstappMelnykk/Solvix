import { Injectable } from '@angular/core';

export interface SectionSettings {
  readonly enabled: boolean;
  // the real axis the plane is perpendicular to: 0 = X, 1 = Y, 2 = Z
  readonly axis: 0 | 1 | 2;
  // where the plane is, 0..1 of the body's extent along that axis
  readonly position: number;
  // which side of the plane stays
  readonly keep: 'above' | 'below';
}

export interface ExploreSettings {
  // draw only the elements the chosen measure does not grade excellent
  readonly onlyBad: boolean;
  // true: the body is filled; false: wholly transparent, only its edges show
  readonly filled: boolean;
  readonly section: SectionSettings;
}

const INITIAL: ExploreSettings = { onlyBad: false, filled: true, section: { enabled: false, axis: 1, position: 0.5, keep: 'above' } };

// How the Quality World is looked into, per session: only the bad elements, and a cut through the body. Plain data
// that the quality render service reads (and keys its cache on); a revision tells when it changed.
@Injectable({ providedIn: 'root' })
export class QualityExploreService {
  private readonly settings = new Map<number, ExploreSettings>();
  private readonly revisions = new Map<number, number>();

  get(sessionId: number): ExploreSettings {
    return this.settings.get(sessionId) ?? INITIAL;
  }

  revision(sessionId: number): number {
    return this.revisions.get(sessionId) ?? 0;
  }

  setOnlyBad(sessionId: number, onlyBad: boolean): void {
    this.update(sessionId, { ...this.get(sessionId), onlyBad });
  }

  setFilled(sessionId: number, filled: boolean): void {
    this.update(sessionId, { ...this.get(sessionId), filled });
  }

  setSection(sessionId: number, change: Partial<SectionSettings>): void {
    const current = this.get(sessionId);
    const next = { ...current.section, ...change };
    next.position = Math.min(1, Math.max(0, Number.isFinite(next.position) ? next.position : 0.5));
    this.update(sessionId, { ...current, section: next });
  }

  // The settings of a session that is gone.
  forget(sessionId: number): void {
    this.settings.delete(sessionId);
    this.revisions.delete(sessionId);
  }

  private update(sessionId: number, next: ExploreSettings): void {
    this.settings.set(sessionId, next);
    this.revisions.set(sessionId, this.revision(sessionId) + 1);
  }
}
