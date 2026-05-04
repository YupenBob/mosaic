import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import sharp from 'sharp';
import { CONTENT_DIR, DIST_DIR, ensureDir, getMtime, asyncPool, log, warn } from './utils.js';

const RESOLUTIONS = [
  { name: '480p', width: 854 },
  { name: '720p', width: 1280 },
  { name: '1080p', width: 1920 },
];

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tiff'];

/**
 * Build glob patterns for all image files in all posts
 */
async function findAllImages() {
  const images = [];
  const postDirs = await fs.readdir(CONTENT_DIR).catch(() => []);
  for (const dir of postDirs) {
    const postPath = path.join(CONTENT_DIR, dir);
    const stat = await fs.stat(postPath);
    if (!stat.isDirectory()) continue;

    // Photos directory
    const photosDir = path.join(postPath, 'photos');
    if (await fs.pathExists(photosDir)) {
      const files = await fs.readdir(photosDir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase().slice(1);
        if (IMAGE_EXTS.includes(ext)) {
          images.push({ dir, sourceDir: photosDir, file, type: 'photo' });
        }
      }
    }

    // Cover image at post root
    const coverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
    for (const name of coverNames) {
      const coverPath = path.join(postPath, name);
      if (await fs.pathExists(coverPath)) {
        images.push({ dir, sourceDir: postPath, file: name, type: 'cover' });
        break; // Only one cover
      }
    }
  }
  return images;
}

async function processImage({ dir, sourceDir, file, type }) {
  const baseName = path.parse(file).name;
  const isCover = type === 'cover';
  const outputSubdir = isCover ? 'media' : 'media/photos';
  const outputDir = path.join(DIST_DIR, 'posts', dir, outputSubdir);
  await ensureDir(outputDir);
  const srcPath = path.join(sourceDir, file);
  const srcMtime = getMtime(srcPath);

  // Cover gets a simple conversion, photos get multi-resolution
  if (isCover) {
    const outPath = path.join(outputDir, 'cover.webp');
    const metaPath = path.join(outputDir, 'cover-meta.json');
    const outMtime = getMtime(outPath);
    if (outMtime <= srcMtime) {
      try {
        const s = sharp(srcPath);
        const meta = await s.metadata();
        const aspect = meta.width && meta.height ? meta.width / meta.height : 1.778;
        // Generate multi-resolution covers for srcset
        await Promise.all([
          s.clone().resize({ width: 854, withoutEnlargement: true }).webp({ quality: 75 }).toFile(path.join(outputDir, 'cover-480p.webp')),
          s.clone().resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(outputDir, 'cover-720p.webp')),
          s.clone().resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 85 }).toFile(path.join(outputDir, 'cover-1080p.webp')),
        ]);
        await fs.writeJSON(metaPath, { w: meta.width, h: meta.height, aspect: Math.round(aspect * 1000) / 1000 });
      } catch (err) {
        warn(`Failed to process cover ${file}: ${err.message}`);
      }
    }
    return;
  }

  // Save photo dimensions for aspect ratio
  let savedMeta = false;
  for (const res of RESOLUTIONS) {
    const outName = `${baseName}-${res.name}.webp`;
    const outPath = path.join(outputDir, outName);
    const outMtime = getMtime(outPath);
    if (outMtime > srcMtime) continue;
    try {
      if (!savedMeta) {
        const meta = await sharp(srcPath).metadata();
        const metaPath = path.join(outputDir, `${baseName}-meta.json`);
        const ar = meta.width && meta.height ? Math.round(meta.width / meta.height * 1000) / 1000 : 1.5;
        await fs.writeJSON(metaPath, { w: meta.width, h: meta.height, aspect: ar });
        savedMeta = true;
      }
      await sharp(srcPath)
        .resize({ width: res.width, withoutEnlargement: true })
        .webp({ quality: _imgQuality[res.name] || 80 })
        .toFile(outPath);
    } catch (err) {
      warn(`Failed to process ${file} at ${res.name}: ${err.message}`);
    }
  }
}

let _imgQuality = { '480p': 75, '720p': 80, '1080p': 85 };

export async function compressImages(imgQuality) {
  if (imgQuality) _imgQuality = { ..._imgQuality, ...imgQuality };
  const images = await findAllImages();
  if (images.length === 0) {
    log('No images found to compress');
    return [];
  }
  log(`Found ${images.length} images to process`);
  await asyncPool(4, images, processImage);
  log('Image compression complete');
  return images;
}

// Allow direct execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
  compressImages().catch(console.error);
}
