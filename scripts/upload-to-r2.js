/**
 * Upload processed media from dist/ to R2 via Worker API.
 * Called by GitHub Actions after build. Uses fetch() to Worker's /api/admin/r2-upload.
 * No rclone, no S3 creds needed — Worker handles R2 directly.
 */
import fs from 'fs';
import path from 'path';

const WORKER_BASE = (process.env.WORKER_API_BASE || '').replace(/\/+$/, '');
if (!WORKER_BASE) {
  console.log('[upload-to-r2] No WORKER_API_BASE set — skipping');
  process.exit(0);
}

const DIST = path.resolve('dist');

function* walkMedia(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { yield* walkMedia(path.join(dir, e.name), prefix + e.name + '/'); continue; }
    if (e.name.endsWith('.html') || e.name.endsWith('.DS_Store')) continue;
    yield { filePath: path.join(dir, e.name), key: prefix + e.name };
  }
}

const UPLOAD_URL = `${WORKER_BASE}/admin/r2-upload`;

async function uploadFile(filePath, r2Key) {
  const buffer = fs.readFileSync(filePath);
  const resp = await fetch(`${UPLOAD_URL}?key=${encodeURIComponent(r2Key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

let total = 0, ok = 0, fail = 0;
for (const slugDir of fs.readdirSync(path.join(DIST, 'posts'))) {
  const mediaDir = path.join(DIST, 'posts', slugDir, 'media');
  if (!fs.existsSync(mediaDir)) continue;

  for (const { filePath, key } of walkMedia(mediaDir, '')) {
    const r2Key = `processed/${slugDir}/${key}`;
    const size = (fs.statSync(filePath).size / 1024).toFixed(1);
    total++;
    try {
      await uploadFile(filePath, r2Key);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  FAIL ${r2Key} (${size}KB): ${e.message}`);
      if (fail > 5) {
        console.error(`[upload-to-r2] Too many failures (${fail}), stopping`);
        process.exit(1);
      }
    }
    if (total % 20 === 0) console.log(`  [upload-to-r2] ${ok}/${total} uploaded...`);
  }
}

console.log(`[upload-to-r2] Complete: ${ok}/${total} uploaded, ${fail} failed`);
