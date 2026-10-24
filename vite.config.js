import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/* Commit and build time written into every session_info row. Both fall back
 * to 'dev' when git is not available (for example a source archive). */
function gitCommit() {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
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
    target: 'es2022',
    rollupOptions: {
      /* Production pages: the experiment and the data-recovery page. */
      input: {
        main: resolve(__dirname, 'index.html'),
        recover: resolve(__dirname, 'recover.html'),
      },
    },
  },
});
