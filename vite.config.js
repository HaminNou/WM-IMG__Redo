import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/* Commit and build time written into every session_info row. Both fall back
 * to 'dev' when git is not available (for example a source archive). */
function gitOutput(args) {
  return execFileSync('git', args, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

/* A build from a tree with uncommitted changes to anything that ships gets
 * `-dirty` appended, so the commit in the data never claims code that the
 * commit does not contain. */
function gitCommit() {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    const sha = gitOutput(['rev-parse', '--short=12', 'HEAD']);
    const changed = gitOutput([
      'status',
      '--porcelain',
      '--',
      'src',
      'public',
      'index.html',
      'recover.html',
      'package.json',
      'package-lock.json',
      'vite.config.js',
    ]);
    return changed ? `${sha}-dirty` : sha;
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  root: '.',
  /* Relative asset paths so the build works under any subpath
   * (a static host may serve at /<user>/<project>/ rather than /). */
  base: './',
  publicDir: 'public',
  define: {
    __BUILD_COMMIT__: JSON.stringify(gitCommit() || 'dev'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    /* Non-default dev port avoids the stock Vite 5173 collision. Keep
     * strictPort:true so the URL stays exactly http://localhost:5273 —
     * with strictPort:false, Vite silently moves to 5274+ and the experiment
     * looks like it is not running if the browser still points at 5273. If the port
     * is busy, free it (`lsof -i :5273`) or run `npm run dev -- --port <n>`. */
    host: true,
    port: 5273,
    strictPort: true,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    /* ES2022 class static blocks (used inside the jsPsych plugins) do not parse
     * before Safari 16.4 and the page would be blank. These targets make esbuild
     * lower them. They are the oldest browsers that have Object.hasOwn, which jsPsych
     * calls on every trial and no build step can supply (MDN browser-compat-data:
     * Chrome/Edge 93, Firefox 92, Safari 15.4); the ES5 gate in index.html names the
     * same versions. `tests/browser-support.test.js` pins the list. */
    target: ['es2020', 'chrome93', 'edge93', 'firefox92', 'safari15.4'],
    rollupOptions: {
      /* Production pages: the experiment and the data-recovery page. */
      input: {
        main: resolve(__dirname, 'index.html'),
        recover: resolve(__dirname, 'recover.html'),
      },
    },
  },
});
