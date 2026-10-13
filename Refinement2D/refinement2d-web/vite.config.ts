import { defineConfig } from 'vite';

// The page asks /api/..., which the dev server hands on to the API (Refinement2D.Api, http://localhost:5190).
export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:5190' }
  }
});
