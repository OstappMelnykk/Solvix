import { Component, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { ZonePaintingService } from '../../state/zone-painting.service';
import { SurfaceZonePaintingService } from '../../state/surface-zone-painting.service';
import { NotificationService } from '../../state/notification.service';

interface ZoneRow {
  readonly id: number;
  readonly color: string;
  readonly voxelCount: number;
  readonly stlCount: number;
}

// The persistent home of "Розмітка зон" (docs/local-refinement/PROBLEMS.md,
// Проблема 2, Варіант D) - a list of already-completed zones, each done in
// one interleaved 2-step pass (voxels, then that SAME zone's STL patch,
// via ZonePaintingComponent/SurfaceZonePaintingComponent - see
// ZonePaintingService.showStep1's own comment for how those 2 sit "on top"
// of this). Replaces the old "paint ALL voxel zones, save, then walk them
// one at a time for STL" 2-phase flow: the old flow made it easy to lose
// track of which voxel zone was which by the time STL painting started.
//
// Deliberately owns NO 3D rendering of its own (no canvas, no WebGL) - it's
// a plain data/UI window over ZonePaintingService/SurfaceZonePaintingService's
// existing state, mounted once at app root like the other zone-painting
// overlays.
@Component({
  selector: 'app-zone-list',
  standalone: true,
  imports: [NgFor, NgIf],
  host: { '[hidden]': 'isHidden()' },
  templateUrl: './zone-list.component.html',
  styleUrl: './zone-list.component.scss'
})
export class ZoneListComponent {
  private readonly zonePainting = inject(ZonePaintingService);
  private readonly surfaceZonePainting = inject(SurfaceZonePaintingService);
  private readonly notifications = inject(NotificationService);

  isHidden(): boolean {
    return this.zonePainting.activeSessionId() === null;
  }

  // Closes the WHOLE feature - back to the main canvas. Also closes step 2
  // defensively (it should never be open while the list itself is being
  // closed, but its own session data living in a separate service means
  // there's no single call that already guarantees this).
  close(): void {
    this.zonePainting.close();
    this.surfaceZonePainting.close();
  }

  voxelCoverageText(): string {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.zonePainting.coverage(sessionId);
    return coverage ? `Вокселі: ${coverage.assigned} / ${coverage.total}` : '';
  }

  voxelCoveragePercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.zonePainting.coverage(sessionId);
    return coverage && coverage.total > 0 ? Math.round((coverage.assigned / coverage.total) * 100) : 0;
  }

  // Null until the first zone's step 2 has actually opened at least once
  // (SurfaceZonePaintingService.open only creates its session then) -
  // shown as "ще немає даних" rather than a misleading 0/0 bar.
  stlCoverageText(): string {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.surfaceZonePainting.coverage(sessionId);
    return coverage ? `STL-поверхня: ${coverage.assigned} / ${coverage.total}` : 'STL-поверхня: ще немає даних';
  }

  stlCoveragePercent(): number {
    const sessionId = this.zonePainting.activeSessionId();
    const coverage = sessionId === null ? null : this.surfaceZonePainting.coverage(sessionId);
    return coverage && coverage.total > 0 ? Math.round((coverage.assigned / coverage.total) * 100) : 0;
  }

  zones(): ZoneRow[] {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return [];
    }
    const zones = this.zonePainting.getSession(sessionId)?.zones ?? [];
    return zones.map(zone => ({
      id: zone.id,
      color: zone.color,
      voxelCount: zone.voxelCount,
      stlCount: this.surfaceZonePainting.cellCountForZone(sessionId, zone.id)
    }));
  }

  // "Редагувати" only ever shows on the LAST row - editing an earlier zone
  // would need to roll back everything painted after it, which the user
  // explicitly asked to keep out of scope; deleting (any row) already
  // covers "I don't want this zone" for non-last zones.
  isLastZone(zoneId: number): boolean {
    const zones = this.zones();
    return zones.length > 0 && zones[zones.length - 1].id === zoneId;
  }

  // Opens the 2-step wizard for a brand-new zone, on top of this list.
  addZone(): void {
    if (this.zonePainting.activeSessionId() === null) {
      return;
    }
    this.zonePainting.showStep1();
  }

  // "Редагувати" the last zone - deletes it (freeing its voxels/STL cells)
  // and immediately reopens the wizard, which then commits a brand-new zone
  // into that exact same, now-vacant slot (finishZone's own `zoneId =
  // zones.length` naturally re-lands on it). Always starts from an empty
  // selection, per explicit request - not a pre-filled edit.
  editLastZone(zoneId: number): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null || !this.isLastZone(zoneId)) {
      return;
    }
    if (!window.confirm('Редагувати цю зону? Поточне виділення (вокселі та STL) для неї буде видалено, і ви розмалюєте її заново.')) {
      return;
    }
    this.zonePainting.deleteZone(sessionId, zoneId);
    this.surfaceZonePainting.deleteZone(sessionId, zoneId);
    this.zonePainting.showStep1();
  }

  // Deleting frees the zone's voxels/STL cells back to unassigned - the
  // painting canvases show them as available again the next time they're
  // opened for a new zone. Both services' deleteZone MUST be called
  // together, in this order, to stay in lockstep (see
  // SurfaceZonePaintingService.deleteZone's own comment) - this is the one
  // place in the app that ever deletes a zone, so there's no other call
  // site to keep in sync.
  deleteZone(zoneId: number): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    if (!window.confirm('Видалити цю зону? Її вокселі та розмітку STL буде звільнено. Це незворотно.')) {
      return;
    }
    this.zonePainting.deleteZone(sessionId, zoneId);
    this.surfaceZonePainting.deleteZone(sessionId, zoneId);
  }

  // The inline color picker - refuses (with an explicit toast, not just a
  // silent no-op) a color already used by another zone, since 2
  // identical-looking zones would be impossible to tell apart in the list
  // or the colored overlays.
  onColorInput(zoneId: number, color: string): void {
    const sessionId = this.zonePainting.activeSessionId();
    if (sessionId === null) {
      return;
    }
    if (this.zonePainting.isColorTaken(sessionId, color, zoneId)) {
      this.notifications.error('Цей колір вже використовується іншою зоною - обери інший.');
      return;
    }
    this.zonePainting.setZoneColor(sessionId, zoneId, color);
  }
}
