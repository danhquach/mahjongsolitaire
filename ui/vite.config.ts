import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Build identity (issue #81): the package version alone cannot identify a
// build (both packages sit at 0.1.0), so the commit and build time are the
// load-bearing stamp. Outside a git checkout (a tarball build) the commit
// reads "unknown" rather than failing the build.
function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(gitCommit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Relative asset paths so the bundle works from any sub-path (Pages/CF, issue #15).
  base: './',
  // Layouts are data files, not code (spec §9 /data): serve them verbatim and
  // copy them into the bundle so the app fetches `layouts/<id>.json` at runtime.
  publicDir: '../data',
  build: { outDir: 'dist-web' },
  // Honour PORT so two checkouts (or two agent sessions) can run `npm run dev`
  // side by side instead of fighting over 5173.
  server: {
    ...(process.env['PORT'] ? { port: Number(process.env['PORT']) } : {}),
    // Issue #118: the feedback form posts to /api/feedback, served in
    // production by the Worker script (worker/index.mjs) alongside the
    // static assets. `vite dev` has no such route, so proxy it to
    // `wrangler dev` (`npx wrangler dev` from the repo root, default port
    // 8787) for local testing.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
