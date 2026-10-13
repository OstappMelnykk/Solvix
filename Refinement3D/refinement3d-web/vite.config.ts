import { defineConfig } from 'vite';

// The page asks /api/..., which the dev server hands on to the API (Refinement3D.Api, http://localhost:5191).
export default defineConfig({
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:5191' }
  }
});
