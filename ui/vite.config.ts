import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the bundle works from any sub-path (Pages/CF, issue #15).
  base: './',
  // Layouts are data files, not code (spec §9 /data): serve them verbatim and
  // copy them into the bundle so the app fetches `layouts/<id>.json` at runtime.
  publicDir: '../data',
  build: { outDir: 'dist-web' },
});
