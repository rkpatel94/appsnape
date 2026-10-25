import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': 'http://localhost:4477',
      '/shots': 'http://localhost:4477',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
