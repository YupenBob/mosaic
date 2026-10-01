import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { buildBlocks, deriveType } from '../blocks.mjs';
import { resolveMedia } from './media.mjs';
export function readPosts(context, manifest) {
  const site = context.config;
  return fs
    .readdirSync(context.content, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(context.content, entry.name, 'index.md')))
    .map((entry) => {
      const slug = entry.name;
      const { data, content } = matter(
        fs.readFileSync(path.join(context.content, slug, 'index.md'), 'utf8').replace(/\r\n/g, '\n'),
      );
      const { photos, videos, music, covers } = resolveMedia(manifest, slug, site);
      const coverRef = String(data.cover || '');
      const indexed = /^(video|photo):(\d+)$/.exec(coverRef);
      let selected = indexed ? (indexed[1] === 'video' ? videos : photos)[Number(indexed[2])] : null;
      if (!indexed && coverRef && !/^(https?:\/\/|\/)/.test(coverRef))
        selected = covers.find((c) => c.file === coverRef) || photos.find((c) => c.file === coverRef);
      if (!coverRef)
        selected = videos.find((v) => v.poster) || photos.find((p) => !p.pending) || covers.find((c) => !c.pending);
      const cover = /^(https?:\/\/|\/)/.test(coverRef) ? coverRef : selected?.poster || selected?.src480 || '';
      const coverSrcset = selected?.variants
        ? Object.fromEntries(
            Object.entries(selected.variants)
              .filter(([tier]) => /^\d+p$/.test(tier))
              .map(([tier, url]) => [parseInt(tier), url]),
          )
        : null;
      const coverAspect = Math.max(site.coverAspectMin, Math.min(site.coverAspectMax, selected?.aspect || 1.5));
      for (const track of music) if (!track.cover && cover) track.cover = cover;
      const videoMode = data.video_mode || 'stacked';
      const { blocks, bodyHTML } = buildBlocks({
        body: content,
        photos,
        videos,
        music,
        videoMode,
        blocksOrder: Array.isArray(data.blocks) ? data.blocks : null,
      });
      return {
        slug,
        title: data.title || slug,
        date: data.date ? new Date(data.date).toISOString() : '',
        category: data.category || 'uncategorized',
        tags: data.tags || [],
        description:
          data.description ||
          content
            .slice(0, 200)
            .replace(/[#*`\[\]()\n]/g, '')
            .trim(),
        videoMode,
        cover,
        coverAspect,
        coverSrcset,
        bodyHTML,
        blocks,
        type: deriveType(blocks),
        photos,
        videos,
        music,
        stats: { views: data.views || 0, likes: data.likes || 0, dwell_time: data.dwell_time || 0 },
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
