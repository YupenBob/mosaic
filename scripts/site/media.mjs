import fs from 'node:fs';
import { emptyManifest, validateManifest, mediaUrl } from '../../shared/media-manifest.mjs';
export function loadManifest(file) {
  return fs.existsSync(file) ? validateManifest(JSON.parse(fs.readFileSync(file, 'utf8'))) : emptyManifest();
}
export function resolveMedia(manifest, slug, site) {
  const result = { photos: [], videos: [], music: [], covers: [] };
  const entries = Object.values(manifest.assets)
    .filter((entry) => entry.slug === slug && entry.status !== 'deleted')
    .sort((a, b) =>
      typeof a.order === 'number' && typeof b.order === 'number'
        ? a.order - b.order
        : String(a.order ?? a.filename).localeCompare(String(b.order ?? b.filename), 'en'),
    );
  const url = (key) => mediaUrl(key, site.mediaBase);
  for (const entry of entries) {
    const output = entry.published;
    const identity = {
      id: entry.id,
      file: entry.filename,
      base: entry.base || entry.filename.replace(/\.[^.]+$/, ''),
      status: output ? 'ready' : entry.status || 'pending',
    };
    if (!output) {
      if (result[entry.folder]) result[entry.folder].push({ ...identity, pending: true });
      continue;
    }
    if (entry.folder === 'photos' || entry.folder === 'covers') {
      const variants = Object.fromEntries(Object.entries(output.variants || {}).map(([tier, key]) => [tier, url(key)]));
      if (!Object.keys(variants).length && output.original) variants.original = url(output.original);
      result[entry.folder].push({
        ...identity,
        variants,
        src10p: url(output.placeholder),
        src480: variants['480p'] || Object.values(variants)[0],
        src720: variants['720p'] || Object.values(variants)[0],
        src1080: variants['1080p'] || Object.values(variants)[0],
        srcOrig: url(output.original),
        thumb: variants['480p'] || Object.values(variants)[0],
        aspect: output.aspect,
      });
    } else if (entry.folder === 'videos') {
      result.videos.push({
        ...identity,
        poster: url(output.poster),
        ...(output.hls ? { hls: url(output.hls) } : {}),
        ...(output.sources
          ? { sources: Object.fromEntries(Object.entries(output.sources).map(([tier, key]) => [tier, url(key)])) }
          : {}),
        ...(output.original ? { src: url(output.original) } : {}),
        duration: output.duration,
        aspect: output.aspect,
      });
    } else if (entry.folder === 'music') {
      result.music.push({
        ...identity,
        title: output.title || identity.base,
        artist: output.artist || site.author?.name || '',
        album: output.album || '',
        cover: url(output.cover),
        sources: Object.fromEntries(Object.entries(output.sources || {}).map(([tier, key]) => [tier, url(key)])),
        duration: output.duration || 0,
        waveform: output.waveform || null,
      });
    }
  }
  return result;
}
