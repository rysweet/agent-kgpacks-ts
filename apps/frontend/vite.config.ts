import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the @kgpacks/frontend SPA.
//
// In dev, `/api/v1` is proxied to the backend (default :8000) so the app can use
// same-origin relative URLs with no CORS round-trips. `VITE_API_BASE_URL` is the
// only public build-time variable (see docs/packages/frontend.md#configuration).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/v1': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
