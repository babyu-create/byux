import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Use relative paths so the production build works under file:// in Electron.
  base: './',
  plugins: [react()],
  server: {
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
