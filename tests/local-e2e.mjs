/**
 * Local E2E runner: serves dist/ on 127.0.0.1:3000 and runs the static-site
 * subset of frontend.spec.js (skips tests that need production API/admin).
 *
 * Run: npm run test:e2e:local   (requires `npm run build` first)
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HOST = '127.0.0.1';
const SERVE_MAIN = require.resolve('serve/build/main.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const ping = () => {
      http
        .get(`http://${HOST}:${port}/index.html`, (r) => {
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

  const port = await getFreePort();
  const server = spawn(process.execPath, [SERVE_MAIN, 'dist', '-l', `tcp://${HOST}:${port}`, '--no-clipboard'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  server.on('error', (e) => console.error('static server error:', e.message));

  try {
    await waitForServer(port);
    console.log(`Serving ${DIST} at http://${HOST}:${port}`);

    const cmd = [
      'npx playwright test tests/frontend.spec.js',
      '--grep-invert "Worker health|mobile viewport|admin login"',
      '--reporter=list',
    ].join(' ');
    const result = spawnSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, SITE: `http://${HOST}:${port}`, ADMIN: 'skip' },
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
