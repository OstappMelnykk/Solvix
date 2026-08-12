import { Component, Input, inject } from '@angular/core';
import { NgFor, NgIf } from '@angular/common';
import { ImportedGeometryService } from '../../../state/imported-geometry.service';
import { ImportedReferenceDisplayService, ImportedReferenceMode } from '../../../state/imported-reference-display.service';
import { ImportedReferenceRenderService } from '../../../state/imported-reference-render.service';

interface GeometryInfoEntry {
  readonly label: string;
  readonly value: string;
}

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

// Extracted out of SettingsPanelComponent - everything about how the
// imported reference geometry (ImportedGeometryService) is displayed,
// scaled, rotated, and measured. Ideal-World-only in practice: the parent
// only renders this via `*ngIf="isIdealWorld()"`, so `sessionId` is the
// only context it needs from outside (same "parent computes identity once,
// child receives it via @Input" shape as WorldCanvasComponent).
@Component({
  selector: 'app-imported-reference-controls',
  standalone: true,
  imports: [NgIf, NgFor],
  templateUrl: './imported-reference-controls.component.html',
  styleUrl: './imported-reference-controls.component.scss'
})
export class ImportedReferenceControlsComponent {
  private readonly importedGeometry = inject(ImportedGeometryService);
  private readonly referenceDisplay = inject(ImportedReferenceDisplayService);
  private readonly referenceRender = inject(ImportedReferenceRenderService);

  @Input({ required: true }) sessionId!: number | null;

  // How the imported reference geometry is currently drawn (ImportedReferenceDisplayService)
  // - read fresh from the template each CD cycle (ImportedGeometryService/
  // ImportedReferenceDisplayService/ImportedReferenceRenderService aren't
  // signal-backed), same pattern SettingsPanelComponent used before this
  // was extracted.
  isReferenceVisible(): boolean {
    const sessionId = this.sessionId;
    return sessionId !== null && this.referenceDisplay.getStyle(sessionId).visible;
  }

  getReferenceMode(): ImportedReferenceMode {
    const sessionId = this.sessionId;
    return sessionId === null ? 'solid' : this.referenceDisplay.getStyle(sessionId).mode;
  }

  getReferenceColorHex(): string {
    const sessionId = this.sessionId;
    const color = sessionId === null ? 0xffffff : this.referenceDisplay.getStyle(sessionId).color;
    return `#${color.toString(16).padStart(6, '0')}`;
  }

  getReferenceOpacityPercent(): number {
    const sessionId = this.sessionId;
    const opacity = sessionId === null ? 0.5 : this.referenceDisplay.getStyle(sessionId).opacity;
    return Math.round(opacity * 100);
  }

  onReferenceVisibleChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceDisplay.setVisible(sessionId, (event.target as HTMLInputElement).checked);
  }

  onReferenceModeChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceDisplay.setMode(sessionId, (event.target as HTMLSelectElement).value as ImportedReferenceMode);
  }

  onReferenceColorChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    const hex = (event.target as HTMLInputElement).value;
    this.referenceDisplay.setColor(sessionId, parseInt(hex.slice(1), 16));
  }

  onReferenceOpacityChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    const percent = Number((event.target as HTMLInputElement).value);
    this.referenceDisplay.setOpacity(sessionId, percent / 100);
  }

  getReferenceDensity(): number {
    const sessionId = this.sessionId;
    return sessionId === null ? 0 : this.referenceRender.getDensity(sessionId);
  }

  onReferenceDensityChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      this.referenceRender.setDensity(sessionId, value);
    }
  }

  isDimensionsVisible(): boolean {
    const sessionId = this.sessionId;
    return sessionId !== null && this.referenceDisplay.getStyle(sessionId).dimensionsVisible;
  }

  onDimensionsVisibleChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceDisplay.setDimensionsVisible(sessionId, (event.target as HTMLInputElement).checked);
  }

  isRulerVisible(): boolean {
    const sessionId = this.sessionId;
    return sessionId !== null && this.referenceDisplay.getStyle(sessionId).rulerVisible;
  }

  onRulerVisibleChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceDisplay.setRulerVisible(sessionId, (event.target as HTMLInputElement).checked);
  }

  getRulerDistance(): number {
    const sessionId = this.sessionId;
    return sessionId === null ? 0 : this.referenceDisplay.getStyle(sessionId).rulerDistance;
  }

  onRulerDistanceChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      this.referenceDisplay.setRulerDistance(sessionId, value);
      // Distance alone doesn't go through setDensity, so the cached ruler
      // needs an explicit rebuild here.
      this.referenceRender.refreshRuler(sessionId);
    }
  }

  isRotateGizmoVisible(): boolean {
    const sessionId = this.sessionId;
    return sessionId !== null && this.referenceDisplay.getStyle(sessionId).rotateGizmoVisible;
  }

  onRotateGizmoVisibleChange(event: Event): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceDisplay.setRotateGizmoVisible(sessionId, (event.target as HTMLInputElement).checked);
  }

  // Puts the reference back to the orientation it had right after import
  // (identity rotation) - the rotate gizmo (world-canvas.component.ts) has
  // no keyboard/UI way to undo a drag on its own, so this is the escape
  // hatch when the user rotates it somewhere they don't want.
  onResetRotation(): void {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      return;
    }
    this.referenceRender.resetRotation(sessionId);
    this.referenceRender.refreshScaledReference(sessionId);
  }

  // Full metadata dictionary for whatever's currently imported
  // (ImportedGeometryService + ImportedReferenceRenderService) - a flat
  // label/value list so the template just iterates it, rather than
  // hand-writing one row per field. Empty (not shown) when nothing's
  // imported for the active session.
  getGeometryInfo(): GeometryInfoEntry[] {
    const sessionId = this.sessionId;
    const info = sessionId === null ? null : this.importedGeometry.get(sessionId);
    if (!info || sessionId === null) {
      return [];
    }
    const scale = this.referenceRender.getScale(sessionId);
    return [
      { label: 'Файл', value: info.fileName },
      { label: 'Watertight', value: info.watertight ? 'так' : 'ні' },
      { label: 'Мешів', value: String(info.meshCount) },
      { label: 'Трикутників', value: info.triangleCount.toLocaleString('uk-UA') },
      { label: 'Вершин', value: info.vertexCount.toLocaleString('uk-UA') },
      { label: 'Розмір X (файл)', value: info.boundingSize.x.toFixed(3) },
      { label: 'Розмір Y (файл)', value: info.boundingSize.y.toFixed(3) },
      { label: 'Розмір Z (файл)', value: info.boundingSize.z.toFixed(3) },
      { label: 'Найдовша вісь', value: AXIS_NAMES[info.longestAxis] },
      { label: 'Найдовша сторона (файл)', value: info.longestLength.toFixed(3) },
      { label: 'Поточний масштаб показу', value: scale !== null ? `×${scale.toFixed(3)}` : '—' },
      { label: 'Показаний розмір (найдовша)', value: String(this.referenceRender.getDensity(sessionId)) }
    ];
  }
}