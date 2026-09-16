import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()], base: './',
  build: {
    emptyOutDir: true, sourcemap: true,
    rollupOptions: { input: { panel: 'panel.html', offscreen: 'offscreen.html', background: 'src/background.ts' },
      output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js' } }
  },
  worker: { format: 'es' }
});
