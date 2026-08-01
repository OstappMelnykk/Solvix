// Dev build (ng serve / ng build without --configuration production).
// Replaced by environment.prod.ts in production builds - see the
// fileReplacements entry in angular.json.
export const environment = {
  production: false,
  // Solvix.Api's https dev profile (see Solvix.Api/Properties/launchSettings.json).
  apiBaseUrl: 'https://localhost:7153'
};