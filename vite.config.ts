import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { resolve } from 'path'

// Vite plugin: copy @ffmpeg/core-mt ESM files to public/lib/mt/ before every
// dev-server start and build so the MT core is always available locally.
// This eliminates the unpkg.com CDN dependency and the 10 s timeout fallback.
function copyMtCore() {
  const mtSrc = resolve(__dirname, 'node_modules/@ffmpeg/core-mt/dist/esm')
  const mtDest = resolve(__dirname, 'public/lib/mt')
  const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js']
  return {
    name: 'copy-mt-core',
    buildStart() {
      mkdirSync(mtDest, { recursive: true })
      for (const f of files) {
        copyFileSync(join(mtSrc, f), join(mtDest, f))
      }
    },
    configureServer() {
      mkdirSync(mtDest, { recursive: true })
      for (const f of files) {
        copyFileSync(join(mtSrc, f), join(mtDest, f))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Use relative paths so the production build works under file:// in Electron.
  base: './',
  plugins: [react(), copyMtCore()],
  server: {
    strictPort: false,
    // COOP/COEP are required to enable SharedArrayBuffer, which the
    // multi-threaded build of ffmpeg.wasm depends on. Without these
    // headers the runtime falls back to the single-threaded core
    // (roughly 1/3 the encode speed for libx264 ultrafast).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
