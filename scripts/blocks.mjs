/**
 * Content-block model: turns a post's body + media into an ordered list of
 * renderable blocks so templates can compose text/gallery/video/music freely.
 *
 * Phase B: legacy ordering only (text → gallery → videos → music, with
 * gallery-first / video-first reordering). Placeholder composition is added
 * in a later phase — see buildBlocks() docs.
 */
import { marked } from 'marked';

const MARKED_OPTS = { breaks: false, gfm: true };

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
 * @returns {{blocks: Array, bodyHTML: string}}
 */
export function buildBlocks({ body, photos = [], videos = [], music = [], layout = 'default', videoMode = 'stacked' }) {
  const textHtml = marked.parse(body || '', MARKED_OPTS);
  const byType = {
    text: { type: 'text', html: textHtml },
    gallery: photos.length ? { type: 'gallery', photos } : null,
    videos: videos.length ? { type: 'videos', videos, mode: videoMode } : null,
    music: music.length ? { type: 'music', tracks: music } : null,
  };
  const order =
    layout === 'gallery-first'
      ? ['gallery', 'text', 'videos', 'music']
      : layout === 'video-first'
        ? ['videos', 'text', 'gallery', 'music']
        : ['text', 'gallery', 'videos', 'music'];
  const blocks = order.map((t) => byType[t]).filter(Boolean);
  return { blocks, bodyHTML: textHtml };
}
