import { defineConfig } from 'vite';

// The page asks /api/..., which the dev server hands on to the API (Refinement3D.Api, http://localhost:5191).
export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 5174),
    proxy: { '/api': process.env.REFINEMENT_API ?? 'http://localhost:5191' }
  }
});
