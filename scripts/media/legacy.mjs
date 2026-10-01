/** One-time bridge from v2 checksum manifests; every advertised object is verified. */
import { assetId, emptyManifest, fingerprint } from '../../shared/media-manifest.mjs';
import { processingConfig } from '../../shared/config.mjs';
import { videoBase } from '../media-names.mjs';
import { tierListFor } from '../media-utils.mjs';
export async function migrateLegacy(store, config, checksums = {}) {
  const manifest = emptyManifest(),
    sources = [];
  const readJSON = async (key) => {
    if (!(await store.head(key))) return null;
    try {
      return JSON.parse(await (await store.get(key)).text());
    } catch {
      return null;
    }
  };
  for await (const object of store.list('originals/')) sources.push(object);
  sources.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  const names = new Map();
  for (const source of sources) {
    const parts = source.key.split('/'),
      slug = parts[1],
      filename = parts.at(-1),
      folder = parts.length === 3 ? 'covers' : parts[2];
    if (!['photos', 'videos', 'music', 'covers'].includes(folder)) continue;
    const seen = names.get(slug) || new Set();
    names.set(slug, seen);
    const base = folder === 'videos' ? videoBase(filename, seen) : filename.replace(/\.[^.]+$/, '');
    const prefix = `processed/${slug}/${folder}`,
      exists = (key) => store.head(key).then(Boolean);
    let published = null,
      complete = false;
    if (folder === 'photos' || folder === 'covers') {
      const name = folder === 'covers' ? 'cover' : base;
      const variants = Object.fromEntries(
        Object.keys(config.imageQuality).map((tier) => [tier, `${prefix}/${name}-${tier}.webp`]),
      );
      const placeholder = `${prefix}/${name}-10p.webp`;
      if ((await Promise.all([placeholder, ...Object.values(variants)].map(exists))).every(Boolean)) {
        const meta = await readJSON(`${prefix}/${name}-meta.json`);
        published = {
          variants,
          placeholder,
          original: source.key,
          aspect:
            meta?.aspect ||
            Number(
              checksums[
                `${folder === 'covers' ? '__cover-meta__' : '__photo-meta__'}/${slug}${folder === 'covers' ? '' : '/' + base}`
              ],
            ) ||
            1.5,
        };
        complete = true;
      }
    } else if (folder === 'videos') {
      let old;
      try {
        old = JSON.parse(checksums[`__video__/${slug}/${base}`] || 'null');
      } catch {
        old = null;
      }
      const tiers = old?.tiers || [],
        playlists = {},
        mp4 = {},
        segments = {};
      for (const tier of tiers) {
        const playlistKey = `${prefix}/${base}-${tier}.m3u8`,
          sourceKey = `${prefix}/${base}-${tier}.mp4`;
        if (!(await exists(playlistKey)) || !(await exists(sourceKey))) continue;
        const playlist = await (await store.get(playlistKey)).text();
        const keys = playlist
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.startsWith('#'))
          .map((line) => `${prefix}/${line.trim()}`);
        if (!keys.length || !(await Promise.all(keys.map(exists))).every(Boolean)) continue;
        playlists[tier] = playlistKey;
        mp4[tier] = sourceKey;
        segments[tier] = keys;
      }
      const poster = `${prefix}/${base}-poster.jpg`,
        hls = `${prefix}/${base}-master.m3u8`;
      // The legacy master may advertise failed tiers. Only reuse it if its entries match verified tiers.
      let masterValid = false;
      if (await exists(hls)) {
        const master = await (await store.get(hls)).text();
        const references = master.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
        masterValid =
          references.length > 0 && references.every((line) => Object.values(playlists).includes(`${prefix}/${line}`));
      }
      if (Object.keys(mp4).length && (await exists(poster)))
        published = { sources: mp4, playlists, segments, poster, ...(masterValid ? { hls } : {}) };
      complete =
        !!published?.hls &&
        tierListFor(old?.height || config.videoQuality.maxHeight, config.videoQuality.maxHeight).every(
          (tier) => mp4[tier],
        );
    } else {
      const variants = Object.fromEntries(
        config.media.audio.bitrates.map((tier) => [tier, `${prefix}/${base}-${tier}.mp3`]),
      );
      if ((await Promise.all(Object.values(variants).map(exists))).every(Boolean)) {
        published = {
          ...(checksums[`music-meta:${slug}:${base}`] || (await readJSON(`${prefix}/${base}-meta.json`)) || {}),
          sources: variants,
          waveform: checksums[`music-waveform:${slug}:${base}`] || (await readJSON(`${prefix}/${base}-waveform.json`)),
          cover: (await exists(`${prefix}/${base}-cover.jpg`)) ? `${prefix}/${base}-cover.jpg` : '',
        };
        complete = true;
      }
    }
    const id = assetId(slug, filename, folder);
    manifest.assets[id] = {
      id,
      slug,
      filename,
      order: filename,
      folder,
      base,
      source: { key: source.key, etag: source.etag, size: source.size },
      version: 1,
      generation: 'legacy',
      configHash: await fingerprint(processingConfig(config, folder)),
      status: complete ? 'ready' : 'pending',
      published,
    };
  }
  return manifest;
}
