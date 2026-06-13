import { compressImages } from '../compress-images.js';

export default {
  name: 'compress-images',
  enabled: true,
  priority: 10,
  async run(ctx) {
    await compressImages(ctx.site?.imageQuality);
    return '';
  }
};
