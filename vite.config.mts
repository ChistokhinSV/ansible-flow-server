// Builds the web application (src/web) into dist/web, which the server serves. `just web-dev`
// runs it with live reload against a server on port 8080.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  // The icon set is the page's favicon and manifest.
  publicDir: '../../media/icons/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2023',
  },
  server: {
    port: 5180,
    proxy: {
      '/api': process.env.AFS_DEV_SERVER ?? 'http://127.0.0.1:8080',
      '/git': process.env.AFS_DEV_SERVER ?? 'http://127.0.0.1:8080',
    },
  },
});
