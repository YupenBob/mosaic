import { extractMusicMeta } from '../extract-music-meta.js';

export default {
  name: 'extract-music',
  enabled: true,
  priority: 25, // After video (20), before generate (30)
  async run(ctx) {
    if (ctx.site?.enableMusicProcessing !== false) {
      const result = await extractMusicMeta(process.env.R2_PUBLIC_URL || ctx.site?.mediaSource?.publicUrl || '');
      return result && Object.keys(result).length > 0 ? `${Object.keys(result).length} tracks` : 'skipped';
    }
    return 'disabled';
  }
};
