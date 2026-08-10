// General app-wide settings, not tied to any single feature - WORLDS_CONFIG
// is one of possibly several exports here. Add other standalone config
// (e.g. toolbar actions, theme) as separate exports in this file rather
// than creating a new one-off config file per feature.

export interface WorldConfig {
  name: string;
}

export const WORLDS_CONFIG: WorldConfig[] = [
  { name: 'Ideal World' },
  { name: 'Real World' },
  { name: 'Solver World' }
];

// Which WORLDS_CONFIG index is Ideal World - the single source of truth for
// "which World shows import-style UI/overlays" (per docs/IDEAS.md R4, Ideal
// World is where topology/algorithm work happens; Real/Solver are derived
// views). RenderWindowComponent and SettingsPanelComponent both gate on
// this - previously each hardcoded its own separate `0`, which could silently
// desync if WORLDS_CONFIG were ever reordered.
export const IDEAL_WORLD_INDEX = 0;