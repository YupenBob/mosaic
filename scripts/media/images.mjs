import path from 'node:path';
import sharp from 'sharp';
export async function processImage({ source, directory, job, store, prefix, publish }) {
  const image = sharp(source, { animated: true }).rotate();
  const metadata = await image.metadata();
  const aspect = metadata.autoOrient?.width / metadata.autoOrient?.height || metadata.width / metadata.height;
  const upload = async (name, pipeline) => {
    const file = path.join(directory, name);
    await pipeline.toFile(file);
    return store.upload(`${prefix}/${name}`, file);
  };
  const original = await upload('original.png', image.clone().png());
  const placeholder = await upload(
    'placeholder.webp',
    image
      .clone()
      .resize({ width: job.config.media.image.placeholderWidth, withoutEnlargement: true })
      .webp({ quality: job.config.media.image.placeholderQuality }),
  );
  const variants = {};
  if (job.config.plugins['compress-images']?.enabled !== false)
    for (const [tier, quality] of Object.entries(job.config.imageQuality))
      variants[tier] = await upload(
        `${tier}.webp`,
        image
          .clone()
          .resize({ width: parseInt(tier), withoutEnlargement: true })
          .webp({ quality }),
      );
  await publish(
    { original, placeholder, variants, aspect, width: metadata.width, height: metadata.height },
    true,
    true,
  );
  return true;
}
