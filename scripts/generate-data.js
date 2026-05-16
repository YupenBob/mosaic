import fs from 'fs-extra';
import path from 'path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { CONTENT_DIR, DIST_DIR, ensureDir, computeScore, writeJSON, readJSON, readFile, log, warn } from './utils.js';

/**
 * Parse all posts from content/ directory
 */
async function parsePosts(site) {
  const compressVideos = site?.enableVideoCompression || false;
  const arMin = site?.coverAspectMin || 0;
  const arMax = site?.coverAspectMax || 999;
  const posts = [];
  const postDirs = await fs.readdir(CONTENT_DIR).catch(() => []);
  for (const dir of postDirs) {
    const postPath = path.join(CONTENT_DIR, dir);
    const stat = await fs.stat(postPath);
    if (!stat.isDirectory()) continue;
    const mdPath = path.join(postPath, 'index.md');
    if (!(await fs.pathExists(mdPath))) {
      warn(`No index.md found in ${dir}, skipping`);
      continue;
    }
    const raw = await readFile(mdPath);
    const { data, content } = matter(raw);
    const slug = dir;
    const title = data.title || slug;
    const date = data.date ? new Date(data.date).toISOString() : '';
    const category = data.category || 'uncategorized';
    const tags = data.tags || [];
    const description = data.description || content.slice(0, 200).replace(/[#*`\[\]()\n]/g, '').trim();
    const cover = data.cover || '';
    const layout = data.layout || 'default'; // default | video-first | gallery-first
    const videoMode = data.video_mode || 'stacked'; // stacked | playlist

    const views = parseInt(data.views) || 0;
    const likes = parseInt(data.likes) || 0;
    const dwellTime = parseInt(data.dwell_time) || 0;
    const score = computeScore(views, likes, dwellTime);

    const bodyHTML = marked.parse(content, { breaks: false, gfm: true });

    // Collect photos metadata
    const photos = [];
    const photosDir = path.join(postPath, 'photos');
    if (await fs.pathExists(photosDir)) {
      const files = (await fs.readdir(photosDir)).sort();
      const imgExts = ['jpg', 'jpeg', 'png', 'webp', 'tiff'];
      for (const f of files) {
        const ext = path.extname(f).toLowerCase().slice(1);
        if (!imgExts.includes(ext)) continue;
        const base = path.parse(f).name;
        photos.push({
          base,
          src480: `media/photos/${base}-480p.webp`,
          src720: `media/photos/${base}-720p.webp`,
          src1080: `media/photos/${base}-1080p.webp`,
          thumb: `media/photos/${base}-480p.webp`,
        });
      }
    }

    // Collect videos metadata
    const videos = [];
    const videosDir = path.join(postPath, 'videos');
    if (await fs.pathExists(videosDir)) {
      const files = (await fs.readdir(videosDir)).sort();
      const vidExts = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
      for (const f of files) {
        const ext = path.extname(f).toLowerCase().slice(1);
        if (!vidExts.includes(ext)) continue;
        const base = path.parse(f).name;
        if (compressVideos) {
          const resNames = ['1080p', '720p', '480p'];
          const sources = {};
          const hasHLS = await fs.pathExists(path.join(DIST_DIR, 'posts', slug, 'media', 'videos', 'master.m3u8'));
          resNames.forEach((res) => {
            const mp4Path = path.join(DIST_DIR, 'posts', slug, 'media', 'videos', `${base}-${res}.mp4`);
            if (fs.existsSync(mp4Path)) sources[res] = `media/videos/${base}-${res}.mp4`;
          });
          videos.push({
            base,
            poster: `media/videos/${base}-poster.jpg`,
            ...(hasHLS ? { hls: 'media/videos/master.m3u8' } : {}),
            ...(Object.keys(sources).length > 0 ? { sources } : {}),
          });
        } else {
          videos.push({
            base,
            src: `media/videos/${f}`,
          });
        }
      }
    }

    // Process cover: auto-detect or explicit
    let coverPath = '';
    if (cover && typeof cover === 'string') {
      const vidMatch = cover.match(/^video:(\d+)$/);
      const photoMatch = cover.match(/^photo:(\d+)$/);
      if (vidMatch && videos.length > parseInt(vidMatch[1])) {
        const idx = parseInt(vidMatch[1]);
        coverPath = videos[idx].poster || videos[idx].src || '';
      } else if (photoMatch && photos.length > parseInt(photoMatch[1])) {
        const idx = parseInt(photoMatch[1]);
        coverPath = photos[idx].src480 || '';
      } else {
        // Explicit file name: will be converted to media/cover.webp by compress-images
        coverPath = 'media/cover.webp';
      }
    } else if (!cover) {
      // Auto-detect: video poster > first photo > empty
      if (videos.length > 0 && videos[0].poster) {
        coverPath = videos[0].poster;
      } else if (videos.length > 0 && videos[0].src) {
        coverPath = videos[0].src; // single-source video (no poster)
      } else if (photos.length > 0) {
        coverPath = photos[0].src480;
      }
    }

    // Read cover aspect ratio from metadata
    let coverAspect = 1.778;
    let coverSrcset = null;
    const coverMetaPath = path.join(DIST_DIR, 'posts', slug, 'media', 'cover-meta.json');
    const coverMeta = await readJSON(coverMetaPath);
    if (coverMeta && coverMeta.aspect) {
      coverAspect = coverMeta.aspect;
    } else if (coverPath && coverPath.includes('media/videos/')) {
      coverAspect = 1.778; // video poster is 16:9
    } else if (coverPath && photos.length > 0) {
      // Read actual photo dimensions from -meta.json
      const photoMeta = await readJSON(path.join(DIST_DIR, 'posts', slug, 'media', 'photos', `${photos[0].base}-meta.json`));
      coverAspect = photoMeta?.aspect || 1.5;
    }

    // Clamp aspect ratio
    if (arMin > 0) coverAspect = Math.max(coverAspect, arMin);
    coverAspect = Math.min(coverAspect, arMax);

    if (coverPath === 'media/cover.webp') {
      coverSrcset = {
        '480': 'media/cover-480p.webp',
        '720': 'media/cover-720p.webp',
        '1080': 'media/cover-1080p.webp',
      };
      coverPath = 'media/cover-1080p.webp';
    }

    posts.push({
      slug,
      title,
      date,
      category,
      tags,
      description,
      layout,
      videoMode,
      cover: coverPath,
      coverAspect,
      coverSrcset,
      bodyHTML,
      photos,
      videos,
      stats: { views, likes, dwell_time: dwellTime },
      score,
    });
  }

  // Sort by composite score descending
  posts.sort((a, b) => b.score - a.score);
  return posts;
}

export async function generateData(site) {
  const posts = await parsePosts(site);
  log(`Parsed ${posts.length} posts`);

  // Build categories
  const categoryMap = {};
  for (const post of posts) {
    const cat = post.category || 'uncategorized';
    if (!categoryMap[cat]) categoryMap[cat] = { name: cat, count: 0, slug: cat.toLowerCase().replace(/\s+/g, '-') };
    categoryMap[cat].count++;
  }
  const categories = Object.values(categoryMap);

  // Build tags
  const tagMap = {};
  for (const post of posts) {
    for (const tag of post.tags) {
      if (!tagMap[tag]) tagMap[tag] = { name: tag, count: 0, slug: tag.toLowerCase().replace(/\s+/g, '-') };
      tagMap[tag].count++;
    }
  }
  const tags = Object.values(tagMap).sort((a, b) => b.count - a.count);

  // Build search index
  const searchIndex = posts.map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    category: p.category,
    tags: p.tags,
    score: p.score,
  }));

  // Write data files
  const dataDir = path.join(DIST_DIR, 'data');
  await ensureDir(dataDir);
  await writeJSON(path.join(dataDir, 'posts.json'), posts);
  await writeJSON(path.join(dataDir, 'categories.json'), categories);
  await writeJSON(path.join(dataDir, 'tags.json'), tags);
  await writeJSON(path.join(dataDir, 'search-index.json'), searchIndex);

  log('Data files generated');
  return { posts, categories, tags, searchIndex };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  generateData().catch(console.error);
}
