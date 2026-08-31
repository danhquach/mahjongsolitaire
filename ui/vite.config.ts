import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the bundle works from any sub-path (Pages/CF, issue #15).
  base: './',
  // Layouts are data files, not code (spec §9 /data): serve them verbatim and
  // copy them into the bundle so the app fetches `layouts/<id>.json` at runtime.
  publicDir: '../data',
  build: { outDir: 'dist-web' },
  // Honour PORT so two checkouts (or two agent sessions) can run `npm run dev`
  // side by side instead of fighting over 5173.
  server: process.env['PORT'] ? { port: Number(process.env['PORT']) } : {},
});
