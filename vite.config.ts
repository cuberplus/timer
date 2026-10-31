import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/timer/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3000 },
  preview: { host: '127.0.0.1' },
  build: {
    outDir: 'build',
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      // Solver workers share pure puzzle code, never the React/document entry.
      output: { manualChunks: { 'cubing-core': ['cubing/alg', 'cubing/kpuzzle', 'cubing/puzzles', 'cubing/scramble', 'cubing/search'] } },
    },
  },
  worker: { format: 'es' },
});
