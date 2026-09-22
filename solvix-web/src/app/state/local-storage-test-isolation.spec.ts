// Global Jasmine hook (registered outside any describe(), so it applies to
// EVERY spec in the whole run, not just this file) - localStorage is a real
// browser API shared across the entire Karma run, unlike TestBed's own DI
// state which resets between tests on its own. Every *StorageService
// (SessionsService, ModelStorageService and its siblings - see
// local-storage-json.ts) now reads/writes it, so without a clear before
// EVERY spec, whichever one happens to run first leaves state that leaks
// into unrelated specs later in the same run - flaky failures that depend
// on execution order rather than on the code under test.
beforeEach(() => {
  localStorage.clear();
});
