import { defineConfig } from 'vitest/config';

// Standalone Vitest config (kept separate from vite.config.ts so the build's
// ffmpeg-core copy plugin doesn't run during tests). Tests target the pure
// logic in src/lib + the Zustand stores, which run fine in a Node environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // exporter.ts pulls in browser-only modules (FFmpeg.wasm, WebCodecs) at
    // import time via motionBlurExporter; tests only import the pure helpers,
    // so no jsdom is needed. Keep this list tight.
  },
});
