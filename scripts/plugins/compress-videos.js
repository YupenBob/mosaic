import { compressVideos } from '../compress-videos.js';

export default {
  name: 'compress-videos',
  enabled: true,
  priority: 20,
  async run(ctx) {
    if (ctx.site?.enableVideoCompression) { await compressVideos(ctx.site?.videoQuality); return 'compressed'; }
    return 'skipped';
  }
};
