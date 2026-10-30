/** Copy the published media manifest into the preview checkout before build. */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { loadContext } from '../lib/context.mjs';
import { createStorage } from '../media/storage.mjs';

const context = loadContext();
const store = createStorage(context.config);
const key = context.config.media?.manifestKey || 'site-data/media-manifest.json';
const object = await store.get(key);
if (!object) {
  console.log(`No media manifest at ${key}; preview will build without published media`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(context.manifestPath), { recursive: true });
await pipeline(object.body, fs.createWriteStream(context.manifestPath));
console.log(`Preview media manifest: ${context.manifestPath}`);
