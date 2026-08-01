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