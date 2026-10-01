/** Published list cache is separate from media processing and written after deployment. */
import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from '../lib/context.mjs';
import { createStorage } from '../media/storage.mjs';
const context = loadContext(),
  store = createStorage(context.config);
for (const name of ['posts-index.json', 'categories.json', 'tags.json'])
  await store.putJSON(`site-data/${name}`, JSON.parse(fs.readFileSync(path.join(context.dist, 'data', name), 'utf8')));
