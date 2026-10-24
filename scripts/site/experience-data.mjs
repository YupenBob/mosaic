/**
 * Experience v2 data artifacts consumed by the front-end overlays.
 *
 * Contract: docs/experience-v2-plan.md §6.
 *  - data/feed.json          → vertical video feed (posts whose manifest has a
 *                              published video), in the site's existing order.
 *  - data/notes/{slug}.json  → per-post detail for the no-navigation note modal,
 *                              fetched lazily on first open.
 *
 * Media URLs are already resolved by `resolveMedia()` with
 * `mediaUrl(key, site.mediaBase)` when posts are read, so every URL emitted here
 * is identical to the one a template/page would use. Existing data/*.json
 * outputs are written by `generate.mjs` and are not touched here.
 *
 * Note `bodyHTML`/`blocks` are build-time output produced from trusted Markdown
 * by `marked` (see scripts/blocks.mjs); they are generated artifacts, not
 * runtime input, and may be re-played in the modal.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} ExperienceDataOptions
 * @property {string} dist       Absolute generated-site directory.
 * @property {object} config     Normalized site config (`context.config`).
 * @property {Array<object>} posts Posts as returned by `readPosts()`.
 */

/**
 * Write feed.json + notes/{slug}.json under `<dist>/data`.
 * Each artifact is skipped when its feature flag is explicitly disabled so a
 * disabled experience ships no dead payload; the dist is rebuilt from scratch
 * every run, so no cleanup is needed.
 *
 * @param {ExperienceDataOptions} options
 * @returns {{ feedItems: number, notes: number, feedBytes: number, noteBytes: number }}
 */
export function writeExperienceData({ dist, config, posts }) {
  const experience = config?.experience || {};
  const dataDir = path.join(dist, 'data');
  const result = { feedItems: 0, notes: 0, feedBytes: 0, noteBytes: 0 };
  fs.mkdirSync(dataDir, { recursive: true });

  if (experience.verticalFeed?.enabled !== false) {
    const feed = buildFeed(posts);
    const file = path.join(dataDir, 'feed.json');
    fs.writeFileSync(file, JSON.stringify(feed));
    result.feedItems = feed.items.length;
    result.feedBytes = fs.statSync(file).size;
  }

  if (experience.modal?.enabled !== false) {
    const notesDir = path.join(dataDir, 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    for (const post of posts) {
      const file = path.join(notesDir, `${post.slug}.json`);
      fs.writeFileSync(file, JSON.stringify(buildNote(post)));
      result.noteBytes += fs.statSync(file).size;
      result.notes += 1;
    }
  }
  return result;
}

/**
 * Build the vertical-feed payload.
 * Only posts with at least one *published* video are included; `pending` video
 * entries have no playable source yet and are skipped rather than shipped as
 * broken slides. Contract fields only — consumers tolerate empty strings/objects.
 *
 * @param {Array<object>} posts
 * @returns {{ version: number, items: Array<object> }}
 */
export function buildFeed(posts) {
  const items = [];
  for (const post of posts || []) {
    const video = (post.videos || []).find((candidate) => !candidate.pending && candidate.sources);
    if (!video) continue;
    items.push({
      slug: post.slug,
      title: post.title,
      description: post.description || '',
      category: post.category,
      tags: post.tags || [],
      date: post.date,
      cover: post.cover || '',
      coverLqip: post.coverLqip || '',
      coverAspect: post.coverAspect,
      coverSrcset: post.coverSrcset || {},
      type: post.type,
      poster: video.poster || '',
      posterLqip: video.posterLqip || '',
      hls: video.hls || null,
      sources: video.sources || {},
      duration: video.duration ?? null,
      aspect: video.aspect || post.coverAspect,
      // Additive convenience field for the overlay's like counter; consumers
      // that only know contract §6 can ignore it.
      stats: post.stats || { views: 0, likes: 0, dwell_time: 0 },
    });
  }
  return { version: 1, items };
}

/**
 * Build one lazy note-detail payload. It mirrors the post page's render input so
 * the modal can replay `blocks` (text/gallery/video/music) without a second
 * fetch and without duplicating the EJS block model.
 *
 * @param {object} post
 * @returns {object}
 */
export function buildNote(post) {
  return {
    slug: post.slug,
    title: post.title,
    date: post.date,
    category: post.category,
    tags: post.tags || [],
    description: post.description || '',
    cover: post.cover || '',
    coverLqip: post.coverLqip || '',
    coverAspect: post.coverAspect,
    coverSrcset: post.coverSrcset || {},
    type: post.type,
    stats: post.stats || { views: 0, likes: 0, dwell_time: 0 },
    bodyHTML: post.bodyHTML || '',
    blocks: post.blocks || [],
    photos: post.photos || [],
    videos: post.videos || [],
    music: post.music || [],
  };
}
