/**
 * Fixture environment for deep UX journeys.
 *
 * Builds a throwaway site (never production content) with the content shapes
 * the live site cannot offer: a multi-video playlist, a music post, nested and
 * special-character taxonomy, an XSS-payload post, a long code post, and
 * enough posts to trigger `page/2` pagination. Media is synthesised locally
 * (HLS levels + segments, MP4, JPEG, MP3) with CORS/Range support, mirroring
 * the playback tests.
 *
 * Usage:
 *   node scripts/qa/build-fixtures.mjs           # build + print the media URL
 *   (journeys use tests/ux/lib/fixtures.mjs, which builds and serves both)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadContext, ROOT } from '../lib/context.mjs';
import { generateSite } from '../site/generate.mjs';
import { serveDirectory } from '../../tests/helpers/static-server.mjs';

const FIXTURE_ROOT = path.join(ROOT, '.mosaic/qa/fixtures');
const SITE_DIR = path.join(FIXTURE_ROOT, 'site');
const CONTENT = path.join(FIXTURE_ROOT, 'content/posts');
const HLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/hls.json'), 'utf8'));
const MEDIA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/media.json'), 'utf8'));
const VIDEO = Buffer.from(HLS.video, 'base64');
const AUDIO = Buffer.from(MEDIA.audio, 'base64');
const PHOTO = Buffer.from(MEDIA.photo, 'base64');

const TWO_LEVEL_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x240,CODECS="avc1.42c00b"',
  'level-240.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x480,CODECS="avc1.42c00b"',
  'level-480.m3u8',
  '',
].join('\n');

/** Serve synthetic media for every fixture reference. */
export function startMediaServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const name = url.pathname.split('/').at(-1) || '';
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (request.headers.origin) headers.Vary = 'Origin';
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS' }).end();
      return;
    }
    let data;
    if (url.pathname.includes('/missing/')) data = null;
    else if (name === 'master.m3u8') data = Buffer.from(TWO_LEVEL_MASTER);
    else if (name === 'level-240.m3u8' || name === 'level-480.m3u8') data = Buffer.from(HLS.level);
    else if (HLS.segments[name]) data = Buffer.from(HLS.segments[name], 'base64');
    else if (name === 'clip.mp4') data = VIDEO;
    else if (name.endsWith('.mp3')) data = AUDIO;
    else if (name === 'photo.jpg' || name === 'poster.jpg') data = PHOTO;
    if (!data) {
      response.writeHead(404, headers).end();
      return;
    }
    headers['Content-Type'] = name.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : name.endsWith('.ts')
        ? 'video/mp2t'
        : name.endsWith('.mp4')
          ? 'video/mp4'
          : name.endsWith('.mp3')
            ? 'audio/mpeg'
            : 'image/jpeg';
    headers['Accept-Ranges'] = 'bytes';
    const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : data.length - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      response.writeHead(206, headers);
      response.end(data.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, headers);
    response.end(data);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

let assetSerial = 0;
function asset(slug, folder, filename, published) {
  // ast_ ids: the build only resolves published v2 assets by their manifest id.
  const id = `ast_qa${String(++assetSerial).padStart(24, '0')}`;
  return {
    id,
    entry: { v2: true, id, slug, folder, filename, status: 'ready', published },
  };
}

function photoAsset(slug, filename = 'photo.jpg') {
  return asset(slug, 'photos', filename, {
    original: 'fixture/photo.jpg',
    placeholder: 'fixture/photo.jpg',
    variants: { '480p': 'fixture/photo.jpg', '720p': 'fixture/photo.jpg', '1080p': 'fixture/photo.jpg' },
    aspect: 1.5,
  });
}

function videoAsset(slug, index) {
  return asset(slug, 'videos', `clip-${index}.mp4`, {
    poster: 'fixture/poster.jpg',
    posterPreview: 'fixture/poster.jpg',
    hls: 'fixture/playlist/master.m3u8',
    sources: { '240p': 'fixture/clip.mp4' },
    duration: 6,
    aspect: 16 / 9,
  });
}

function musicAsset(slug, filename = 'track.mp3') {
  return asset(slug, 'music', filename, {
    title: '圆舞曲练习',
    artist: 'Fixture',
    sources: { '128k': `fixture/music/${filename}` },
    cover: 'fixture/photo.jpg',
    coverPreview: 'fixture/photo.jpg',
    duration: 6,
    waveform: [0.2, 0.5, 0.35, 0.8, 0.6, 0.45, 0.9, 0.3, 0.55, 0.7],
  });
}

function frontMatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(item)).join(', ')}]`);
    } else if (value && typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function writePost(slug, data, body) {
  fs.mkdirSync(path.join(CONTENT, slug), { recursive: true });
  fs.writeFileSync(path.join(CONTENT, slug, 'index.md'), `${frontMatter(data)}\n\n${body}\n`);
}

/** Build the fixture content + manifest (deterministic). */
export function writeFixtureContent(mediaBase) {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CONTENT, { recursive: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, '.mosaic'), { recursive: true });
  if (!fs.existsSync(path.join(FIXTURE_ROOT, 'src')))
    fs.symlinkSync(path.join(ROOT, 'src'), path.join(FIXTURE_ROOT, 'src'));
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'mosaic.config.json'),
    JSON.stringify(
      {
        title: 'Mosaic QA Fixtures',
        subtitle: 'fixtures',
        description: 'Throwaway QA fixture site.',
        url: 'http://fixtures.local',
        apiBase: '/api',
        mediaBase,
        language: 'zh-CN',
        author: { name: 'Fixture' },
        pageSize: 20,
        searchMinChars: 2,
        enableBusuanzi: false,
        experience: {
          card: { size: 'large', image: 'full', layout: 'masonry' },
          modal: { enabled: true },
          verticalFeed: { enabled: true },
          motion: { enabled: true, spring: 'snappy' },
          morphIcons: { enabled: true },
        },
        components: {
          gallery: { enabled: true, zoom: true, lazyLoad: true },
          video: { enabled: true, quality: ['240p', '480p'] },
          search: { enabled: true },
          likes: { enabled: true },
          stats: { enabled: true },
        },
        themeMode: { default: 'auto', accent: 'blue', allowVisitorToggle: true, showMenu: true },
        theme: 'auto',
        themePackage: 'default',
        player: { hls: { maxBufferLength: 12 } },
      },
      null,
      2,
    ),
  );

  const assets = {};
  const add = (created) => {
    assets[created.entry.id] = created.entry;
    return created.entry.id;
  };

  // 1) Playlist post with three videos (playlist mode auto-advance).
  const vids = [videoAsset('playlist-deep', 0), videoAsset('playlist-deep', 1), videoAsset('playlist-deep', 2)].map(
    add,
  );
  writePost(
    'playlist-deep',
    {
      title: '播放列表深度测试',
      date: '2026-11-01T10:00:00.000Z',
      category: '视频',
      tags: ['播放列表', 'test'],
      description: '三段视频的播放列表',
      video_mode: 'playlist',
      views: 12,
      likes: 3,
      media: { gallery: [], videos: vids, music: [], cover: null },
    },
    '第一段\n\n{{videos}}',
  );

  // 2) Music post.
  const music = add(musicAsset('music-deep', 'track-1.mp3'));
  const musicTwo = add(musicAsset('music-deep', 'track-2.mp3'));
  writePost(
    'music-deep',
    {
      title: '音乐播放深度测试',
      date: '2026-10-30T09:00:00.000Z',
      category: '音乐',
      tags: ['音乐', 'test'],
      description: '单曲波形播放',
      views: 7,
      likes: 2,
      media: { gallery: [], videos: [], music: [music, musicTwo], cover: null },
    },
    '听一段合成音。\n\n{{music}}',
  );

  // 3) Gallery post with four photos.
  const photos = [
    photoAsset('gallery-deep', 'a.jpg'),
    photoAsset('gallery-deep', 'b.jpg'),
    photoAsset('gallery-deep', 'c.jpg'),
    photoAsset('gallery-deep', 'd.jpg'),
  ].map(add);
  writePost(
    'gallery-deep',
    {
      title: '画廊缩放测试',
      date: '2026-10-29T08:00:00.000Z',
      category: '摄影',
      tags: ['画廊', 'zoom'],
      description: '四张合成图片',
      views: 5,
      likes: 1,
      media: { gallery: photos, videos: [], music: [], cover: photos[0] },
    },
    '{{photo:0}}\n\n{{photo:1}}\n\n{{photo:2}}\n\n{{photo:3}}',
  );

  // 4) Mixed blocks + long text with code.
  const mixedPhoto = add(photoAsset('mixed-deep', 'm.jpg'));
  const mixedVideo = add(videoAsset('mixed-deep', 0));
  const mixedMusic = add(musicAsset('mixed-deep'));
  writePost(
    'mixed-deep',
    {
      title: '混合内容与代码块',
      date: '2026-10-28T07:00:00.000Z',
      category: '摄影/胶片',
      tags: ['混合', '代码'],
      description: '图片、视频、音乐与代码块',
      views: 3,
      likes: 0,
      media: { gallery: [mixedPhoto], videos: [mixedVideo], music: [mixedMusic], cover: null },
    },
    [
      '{{photo:0}}',
      '',
      '## 代码块',
      '',
      '```js',
      'export function fixture(value) {',
      '  return value * 2;',
      '}',
      '```',
      '',
      '{{video:0}}',
      '',
      '{{music}}',
    ].join('\n'),
  );

  // 5) Special-character taxonomy + XSS payload fields.
  writePost(
    'xss-deep',
    {
      title: 'XSS 载荷 <img src=x onerror="window.__xss=1">',
      date: '2026-10-27T06:00:00.000Z',
      category: '安全',
      tags: ['xss-test', '标签 空格'],
      description: '<script>window.__xss=2</script>description',
      views: 0,
      likes: 0,
      media: { gallery: [], videos: [], music: [], cover: null },
    },
    '正文只包含普通文本：元数据载荷不应被执行。',
  );

  // 5b) Authored raw HTML is a documented trust decision: post bodies come from
  // the repository/admin author, same trust boundary as the code. The fixture
  // proves the build renders it (and therefore authors can ship HTML).
  writePost(
    'trusted-html-deep',
    {
      title: '作者信任 HTML',
      date: '2026-10-26T05:00:00.000Z',
      category: '安全',
      tags: ['trusted-html'],
      description: '正文内联 HTML 属于作者信任边界',
      views: 0,
      likes: 0,
      media: { gallery: [], videos: [], music: [], cover: null },
    },
    ['正文内联 HTML：', '', '<script>window.__trusted=3</script>', '', '<div class="raw-html">raw</div>'].join('\n'),
  );

  // 5b2) Wallpaper post: gives search/IME journeys a 壁纸 match.
  writePost(
    'wallpaper-deep',
    {
      title: '壁纸摄影练习',
      date: '2026-10-22T01:00:00.000Z',
      category: '壁纸',
      tags: ['壁纸', '摄影'],
      description: '壁纸标签搜索目标',
      views: 0,
      likes: 0,
      media: { gallery: [], videos: [], music: [], cover: null },
    },
    '壁纸测试内容。',
  );

  // 5c) Single-video posts: HLS+fallback, native MP4 only, and broken HLS.
  const single = add(videoAsset('single-video', 0));
  writePost(
    'single-video',
    {
      title: '单个 HLS 视频',
      date: '2026-10-25T04:00:00.000Z',
      category: '视频',
      tags: ['视频', 'hls'],
      description: '单视频 HLS + MP4 回退',
      views: 4,
      likes: 0,
      media: { gallery: [], videos: [single], music: [], cover: null },
    },
    '单视频。\n\n{{video:0}}',
  );
  const native = add(
    asset('native-video', 'videos', 'native.mp4', {
      poster: 'fixture/poster.jpg',
      sources: { '240p': 'fixture/clip.mp4' },
      duration: 6,
      aspect: 16 / 9,
    }),
  );
  writePost(
    'native-video',
    {
      title: '原生 MP4 视频',
      date: '2026-10-24T03:00:00.000Z',
      category: '视频',
      tags: ['视频', 'mp4'],
      description: '没有 HLS 的原生视频',
      views: 2,
      likes: 0,
      media: { gallery: [], videos: [native], music: [], cover: null },
    },
    '原生视频。\n\n{{video:0}}',
  );
  const broken = add(
    asset('broken-video', 'videos', 'broken.mp4', {
      poster: 'fixture/poster.jpg',
      hls: 'fixture/missing/master.m3u8',
      sources: { '240p': 'fixture/clip.mp4' },
      duration: 6,
      aspect: 16 / 9,
    }),
  );
  writePost(
    'broken-video',
    {
      title: 'HLS 损坏回退',
      date: '2026-10-23T02:00:00.000Z',
      category: '视频',
      tags: ['视频', 'fallback'],
      description: 'manifest 404 时应回退 MP4',
      views: 1,
      likes: 0,
      media: { gallery: [], videos: [broken], music: [], cover: null },
    },
    '损坏回退。\n\n{{video:0}}',
  );

  // 6) Pagination filler posts (55) -> 60 total, pageSize 20.
  for (let i = 1; i <= 55; i++) {
    const slug = `page-${String(i).padStart(2, '0')}`;
    writePost(
      slug,
      {
        title: `分页文章 ${String(i).padStart(2, '0')}`,
        date: new Date(Date.UTC(2026, 8, 1, 0, 0, 0) - i * 3600 * 1000).toISOString(),
        category: i % 2 ? '分页' : '随笔',
        tags: ['分页', `第${i}篇`],
        description: `分页测试文章 ${i}`,
        views: i,
        likes: 0,
        media: { gallery: [], videos: [], music: [], cover: null },
      },
      `这是第 ${i} 篇分页测试文章的内容。`,
    );
  }

  fs.writeFileSync(
    path.join(FIXTURE_ROOT, '.mosaic/media-manifest.json'),
    JSON.stringify({ schemaVersion: 2, revision: 99, assets }, null, 2),
  );
  return { root: FIXTURE_ROOT, assets: Object.keys(assets).length };
}

/** Build the fixture site against a running media server. */
export function buildFixtureSite(mediaBase) {
  const written = writeFixtureContent(mediaBase);
  const context = loadContext({
    ...process.env,
    MOSAIC_ROOT: FIXTURE_ROOT,
    MOSAIC_DIST: SITE_DIR,
    MEDIA_MANIFEST_FILE: path.join(FIXTURE_ROOT, '.mosaic/media-manifest.json'),
    GITHUB_SHA: 'fixtures',
  });
  const result = generateSite(context);
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/generate-brand-assets.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOSAIC_ROOT: FIXTURE_ROOT,
      MOSAIC_DIST: SITE_DIR,
      MEDIA_MANIFEST_FILE: path.join(FIXTURE_ROOT, '.mosaic/media-manifest.json'),
    },
    stdio: 'ignore',
  });
  return { ...written, posts: result.posts, siteDir: SITE_DIR };
}

/** Build + serve the fixture site and its media; used by the journey runner. */
export async function startFixtures() {
  const media = await startMediaServer();
  const built = buildFixtureSite(media.url);
  const site = await serveDirectory(SITE_DIR, { notFoundFile: '404.html' });
  return {
    base: site.url,
    mediaUrl: media.url,
    siteDir: SITE_DIR,
    posts: built.posts,
    close: async () => {
      await site.close();
      await media.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const media = await startMediaServer();
  console.log(JSON.stringify(buildFixtureSite(media.url)));
  await media.close();
}
