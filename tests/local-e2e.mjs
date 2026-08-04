/**
 * Local E2E runner: serves dist/ on 127.0.0.1:3000 and runs the static-site
 * subset of frontend.spec.js (skips tests that need production API/admin).
 *
 * Run: npm run test:e2e:local   (requires `npm run build` first)
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 3000;
const HOST = '127.0.0.1';
const SERVE_MAIN = require.resolve('serve/build/main.js');

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const ping = () => {
      http
        .get(`http://${HOST}:${PORT}/index.html`, (r) => {
          r.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('static server did not start in time'));
          else setTimeout(ping, 300);
        });
    };
    ping();
  });
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/ not built — run `npm run build` first.');
    process.exit(1);
  }

  const server = spawn(process.execPath, [SERVE_MAIN, 'dist', '-l', `tcp://${HOST}:${PORT}`, '--no-clipboard'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  server.on('error', (e) => console.error('static server error:', e.message));

  try {
    await waitForServer();
    console.log(`Serving ${DIST} at http://${HOST}:${PORT}`);

    const cmd = [
      'npx playwright test tests/frontend.spec.js',
      '--grep-invert "Worker health|mobile viewport|admin login"',
      '--reporter=list',
    ].join(' ');
    const result = spawnSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, SITE: `http://${HOST}:${PORT}`, ADMIN: 'skip' },
      timeout: 10 * 60 * 1000,
    });
    process.exit(result.status ?? 1);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
