import path from 'node:path';
import { loadContext } from './lib/context.mjs';
import { stageAdmin } from './lib/published-assets.mjs';
const { root } = loadContext();
const output = process.env.ADMIN_DIST || path.join(root, '.mosaic/admin-dist');
console.log('Admin asset version:', stageAdmin(path.join(root, 'cloud-admin'), output, root));
