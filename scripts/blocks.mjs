/**
 * Content-block model: turns a post's body + media into an ordered list of
 * renderable blocks so templates can compose text/gallery/video/music freely.
 *
 * Placeholders (must be alone on a line, surrounded by blank lines):
 *   {{gallery}} {{videos}} {{music}} {{video:N}} {{photo:N}}
 * - Placeholders decide block placement; media types not referenced by a
 *   gallery/videos/music placeholder are appended at the end (never silently
 *   dropped, never duplicated).
 * - Out-of-range video:N / photo:N references stay literal in the text so the
 *   author sees them.
 * - Without placeholders, legacy ordering applies: text → gallery → videos →
 *   music, with gallery-first / video-first reordering.
 */
import { marked } from 'marked';

const MARKED_OPTS = { breaks: false, gfm: true };
const DEFAULT_MEDIA_ORDER = ['gallery', 'videos', 'music'];
const PLACEHOLDER_RE = /^\s*\{\{(gallery|videos|music|video:(\d+)|photo:(\d+))\}\}\s*$/;

/**
 * Build the ordered block list for a post.
 *
 * @param {object} input
 * @param {string} input.body        Raw Markdown body.
 * @param {Array}  input.photos      Parsed photo objects.
 * @param {Array}  input.videos      Parsed video objects.
 * @param {Array}  input.music       Parsed music track objects.
 * @param {string} input.layout      default | gallery-first | video-first.
 * @param {string} input.videoMode   stacked | playlist (used by the videos block).
 * @param {Array}  input.blocksOrder Optional explicit type order (text/gallery/
 *                                   videos/music); ignored when placeholders are
 *                                   present (placeholder order wins).
 * @returns {{blocks: Array, bodyHTML: string}}
 */
export function buildBlocks({
  body,
  photos = [],
  videos = [],
  music = [],
  layout = 'default',
  videoMode = 'stacked',
  blocksOrder = null,
}) {
  const lines = String(body || '').split(/\r?\n/);
  const blocks = [];
  const placed = new Set();
  let buf = [];
  let anyPlaceholder = false;

  const flushText = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) blocks.push({ type: 'text', html: marked.parse(text, MARKED_OPTS) });
  };
  const mediaBlock = (raw, index) => {
    const kind = raw.split(':')[0];
    if (kind === 'gallery') return photos.length ? { type: 'gallery', photos } : null;
    if (kind === 'videos') return videos.length ? { type: 'videos', videos, mode: videoMode } : null;
    if (kind === 'music') return music.length ? { type: 'music', tracks: music } : null;
    if (kind === 'photo') return photos[index] ? { type: 'photo', photo: photos[index] } : null;
    if (kind === 'video') return videos[index] ? { type: 'video', video: videos[index] } : null;
    return null;
  };
  const isBlank = (s) => s.trim() === '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = PLACEHOLDER_RE.exec(line);
    const prevBlank = i === 0 || isBlank(lines[i - 1]);
    const nextBlank = i === lines.length - 1 || isBlank(lines[i + 1]);
    if (m && prevBlank && nextBlank) {
      anyPlaceholder = true;
      const raw = m[1];
      const kind = raw.split(':')[0];
      const index = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : null;
      // Out-of-range references stay literal so the author notices them.
      if ((kind === 'video' && !videos[index]) || (kind === 'photo' && !photos[index])) {
        buf.push(line);
        continue;
      }
      flushText();
      const block = mediaBlock(raw, index);
      if (block) {
        blocks.push(block);
        if (kind === 'gallery' || kind === 'videos' || kind === 'music') placed.add(kind);
      }
    } else {
      buf.push(line);
    }
  }
  flushText();

  if (!anyPlaceholder) {
    // Legacy ordering (backward compatible).
    const byType = {
      text: blocks.find((b) => b.type === 'text') || null,
      gallery: photos.length ? { type: 'gallery', photos } : null,
      videos: videos.length ? { type: 'videos', videos, mode: videoMode } : null,
      music: music.length ? { type: 'music', tracks: music } : null,
    };
    const order =
      Array.isArray(blocksOrder) && blocksOrder.length
        ? blocksOrder
        : layout === 'gallery-first'
          ? ['gallery', 'text', 'videos', 'music']
          : layout === 'video-first'
            ? ['videos', 'text', 'gallery', 'music']
            : ['text', 'gallery', 'videos', 'music'];
    return {
      blocks: order.map((t) => byType[t]).filter(Boolean),
      bodyHTML: byType.text ? byType.text.html : '',
    };
  }

  // Append media types not placed by placeholders (never drop, never duplicate).
  for (const kind of DEFAULT_MEDIA_ORDER) {
    if (placed.has(kind)) continue;
    const block = mediaBlock(kind, null);
    if (block) blocks.push(block);
  }

  const bodyHTML = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.html)
    .join('\n');
  return { blocks, bodyHTML };
}

/**
 * Derive a coarse post type from its blocks. Text alone does not make a post
 * "mixed": a gallery post with an intro is still 'gallery'.
 */
export function deriveType(blocks) {
  const has = (t) => blocks.some((b) => b.type === t);
  if (has('videos') || has('video')) return has('gallery') || has('photo') || has('music') ? 'mixed' : 'video';
  if (has('gallery') || has('photo')) return has('music') ? 'mixed' : 'gallery';
  if (has('music')) return 'music';
  return 'text';
}
