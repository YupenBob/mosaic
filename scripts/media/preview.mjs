/**
 * Tiny image previews (LQIP) for media posters and covers.
 *
 * Card grids load these few-KB WebP previews first and upgrade to the real
 * image once it decodes (see `src/assets/js/cards/media.js`). Settings are
 * shared with the existing image-placeholder pipeline so enabling previews
 * never changes the media processing fingerprint:
 * `config.media.image.placeholderWidth` / `placeholderQuality`.
 */
import sharp from 'sharp';

/**
 * Write a small WebP preview from a full-size image file.
 * @param {object} options
 * @param {string} options.input - source image path
 * @param {string} options.output - destination `.webp` path
 * @param {number} options.width - preview width in px
 * @param {number} options.quality - WebP quality (1-100)
 * @returns {Promise<void>}
 */
export async function writeWebpPreview({ input, output, width, quality }) {
  await sharp(input).rotate().resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(output);
}
