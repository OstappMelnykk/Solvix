import { Injectable } from '@angular/core';

// Deliberately app-controlled, proactive eviction instead of reacting to the
// browser's own (unpredictable, all-at-once) eviction after the fact - see
// [[project_webgl_context_architecture]] for the incident this exists to fix:
// every canvas-owning lazy tool (zone-preview, six-view-overlay, zone-painting,
// surface-zone-painting) holds its real WebGL context for the whole session
// once first created (dispose() alone never frees it - only destroying the
// actual <canvas> DOM element does), so simply using several tools in one
// session accumulates contexts past the browser's per-page limit (commonly
// ~16 in Chrome), and the browser's own recovery then evicts something
// essentially at random, cascading across unrelated tools.
//
// This is a simple LRU cap: every canvas-owning panel registers itself here
// the moment it successfully gets a real context, and calls touch() every
// frame it actually renders. Once the registered count would exceed
// MAX_CONTEXTS, the least-recently-touched entry is forced to give up its
// context (via its own `evict` callback - the SAME "recreate my <canvas> via
// a trackBy generation bump" mechanism each of these components already uses
// to recover from a genuinely lost context, just triggered proactively here
// instead of reactively after a browser eviction).
//
// Deliberately does NOT cover WorldCanvasComponent's own 3 canvases - those
// are a small, fixed, foundational cost by design (docs/FRONTEND_ARCHITECTURE.md:
// "рівно 3 WebGL-контексти за весь час роботи"), not something to evict.
// MAX_CONTEXTS leaves headroom for them: 3 (World, always reserved) +
// MAX_CONTEXTS (everything else, LRU-capped) stays safely under ~16.
@Injectable({ providedIn: 'root' })
export class WebglContextBudgetService {
  private readonly MAX_CONTEXTS = 10;
  private readonly entries = new Map<string, { lastUsed: number; evict: () => void }>();

  // Called right after a panel's WebGLRenderer construction succeeds. Safe
  // to call again for an id that's already registered (e.g. a tool being
  // reopened onto the SAME still-live canvas/context, which three.js just
  // reuses rather than recreating) - that's treated as a touch(), not a
  // fresh registration, so it never double-counts against the budget.
  register(id: string, evict: () => void): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastUsed = Date.now();
      return;
    }
    if (this.entries.size >= this.MAX_CONTEXTS) {
      this.evictLeastRecentlyUsed();
    }
    this.entries.set(id, { lastUsed: Date.now(), evict });
  }

  // Called every frame a registered panel actually renders, so an
  // actively-used panel is never the eviction target while a stale one
  // (belonging to a tool the user closed or switched away from, but whose
  // canvas element was never destroyed) sits idle and available to reclaim.
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastUsed = Date.now();
    }
  }

  // Called by a panel's own `evict` callback once it has actually finished
  // giving up its context (so a later register() for the same id is treated
  // as fresh, not a stale touch()) - NOT called from a component's routine
  // hide/teardown path, since that only disposes the three.js-side wrapper
  // and leaves the real context reserved on the still-mounted canvas (see
  // this file's own header comment) - unregistering there would make this
  // service think budget was freed when it wasn't.
  unregister(id: string): void {
    this.entries.delete(id);
  }

  private evictLeastRecentlyUsed(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId === null) {
      return;
    }
    const victim = this.entries.get(oldestId)!;
    this.entries.delete(oldestId);
    victim.evict();
  }
}
