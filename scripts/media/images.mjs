import path from 'node:path';
import sharp from 'sharp';

/** Quality used for JPEG/WebP sanitized originals (visually lossless-ish). */
const ORIGINAL_QUALITY = 90;
/** Source formats whose published original keeps the same extension. */
const SAME_FORMAT_EXTENSIONS = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };

/**
 * Choose the published original's extension/encoder.
 *
 * The previous pipeline always wrote `original.png`, which mislabels JPEG/WebP
 * sources and can inflate them several times over. Originals now keep their
 * source format (`jpg`/`jpeg`/`webp`/`png`); PNG is used whenever the image has
 * transparency (the only format here that needs it) or keeps animated frames.
 * Any other source format (tiff, gif, avif, ...) becomes PNG only when it has
 * alpha, otherwise JPEG. `sharp(...).rotate()` re-encodes without metadata, so
 * EXIF/GPS is stripped by the same pass.
 *
 * @param {{format?: string, hasAlpha?: boolean, pages?: number}} metadata - sharp metadata
 * @param {string} sourceName - local source path (extension is preserved)
 * @returns {{extension: string, format: 'jpeg'|'png'|'webp'}}
 */
export function originalTarget(metadata, sourceName) {
  if (metadata.hasAlpha === true) return { extension: 'png', format: 'png' };
  const format = String(metadata.format || '').toLowerCase();
  const sourceExtension = path.extname(sourceName).slice(1).toLowerCase();
  const extension = SAME_FORMAT_EXTENSIONS[format];
  if (extension)
    return {
      // `JPEG` sources may be uploaded as `.jpeg`; keep whichever name was used.
      extension: extension === 'jpg' && sourceExtension === 'jpeg' ? 'jpeg' : extension,
      format: format === 'jpg' ? 'jpeg' : format,
    };
  // Animated sources keep every frame; PNG (APNG) is the only lossless option here.
  if ((metadata.pages || 1) > 1) return { extension: 'png', format: 'png' };
  return { extension: 'jpg', format: 'jpeg' };
}

/**
 * Encode the sanitized original with the chosen target format.
 * @param {import('sharp').Sharp} image
 * @param {{format: 'jpeg'|'png'|'webp'}} target
 */
function encodeOriginal(image, target) {
  if (target.format === 'jpeg') return image.clone().jpeg({ quality: ORIGINAL_QUALITY });
  if (target.format === 'webp') return image.clone().webp({ quality: ORIGINAL_QUALITY });
  return image.clone().png();
}

export async function processImage({ source, directory, job, store, prefix, publish, budgetExceeded }) {
  const image = sharp(source, { animated: true }).rotate();
  const metadata = await image.metadata();
  const aspect = metadata.autoOrient?.width / metadata.autoOrient?.height || metadata.width / metadata.height;
  const upload = async (name, pipeline) => {
    const file = path.join(directory, name);
    await pipeline.toFile(file);
    return store.upload(`${prefix}/${name}`, file);
  };
  // A budget stop before any output is a clean requeue (no partial publish).
  if (budgetExceeded?.()) return false;
  const target = originalTarget(metadata, source);
  const original = await upload(`original.${target.extension}`, encodeOriginal(image, target));
  const placeholder = await upload(
    'placeholder.webp',
    image
      .clone()
      .resize({ width: job.config.media.image.placeholderWidth, withoutEnlargement: true })
      .webp({ quality: job.config.media.image.placeholderQuality }),
  );
  const published = {
    original,
    placeholder,
    variants: {},
    aspect,
    width: metadata.width,
    height: metadata.height,
  };
  if (job.config.plugins['compress-images']?.enabled === false) {
    await publish({ ...published }, true, true);
    return true;
  }
  for (const [tier, quality] of Object.entries(job.config.imageQuality)) {
    // Safe point between tiers: publish the already verified objects as a
    // partial generation so a budget-interrupted run is playable immediately.
    if (budgetExceeded?.()) {
      await publish({ ...published }, false, true);
      return false;
    }
    published.variants[tier] = await upload(
      `${tier}.webp`,
      image
        .clone()
        .resize({ width: parseInt(tier), withoutEnlargement: true })
        .webp({ quality }),
    );
  }
  await publish({ ...published }, true, true);
  return true;
}
