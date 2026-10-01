import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { ALL_RES, tierListFor } from '../media-utils.mjs';
export async function processVideo({ source, directory, job, store, prefix, publish, budgetExceeded, signal }) {
  const info = JSON.parse(
    (
      await runProcess('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], {
        capture: true,
        signal,
      })
    ).toString(),
  );
  const stream = info.streams.find((s) => s.codec_type === 'video');
  if (!stream?.height) throw new Error('Video has no decodable video stream');
  const config = job.config.videoQuality;
  const compressed = job.config.plugins['compress-videos']?.enabled !== false;
  const targets = compressed ? tierListFor(stream.height, config.maxHeight) : ['source'];
  if (!targets.length) targets.push('source');
  const output = {
    ...job.checkpoint,
    sources: { ...job.checkpoint.sources },
    playlists: { ...job.checkpoint.playlists },
    segments: { ...job.checkpoint.segments },
    duration: Number(info.format?.duration) || 0,
    aspect: stream.width / stream.height,
  };
  const posterFile = path.join(directory, 'poster.jpg');
  const posterAt = Math.max(0, Math.min(config.posterSeconds, output.duration / 2));
  if (!output.poster || !(await store.head(output.poster))) {
    await runProcess(
      'ffmpeg',
      ['-i', source, '-ss', String(posterAt), '-frames:v', '1', '-vf', 'scale=-2:720', '-y', posterFile],
      { signal },
    );
    output.poster = await store.upload(`${prefix}/poster.jpg`, posterFile);
  }
  let changed = false,
    completed = 0;
  const commit = async () => {
    const tiers = Object.keys(output.sources);
    if (!tiers.length) return;
    // Every master is immutable; adding a tier never changes an old deployment.
    const revision = tiers.join('-');
    const masterFile = path.join(directory, 'master.m3u8');
    const master =
      '#EXTM3U\n#EXT-X-VERSION:3\n' +
      tiers
        .map((tier) => {
          const res = ALL_RES.find((r) => r.name === tier);
          const relative = path.posix
            .relative(prefix, output.playlists[tier])
            .split('/')
            .map(encodeURIComponent)
            .join('/');
          return `#EXT-X-STREAM-INF:BANDWIDTH=${res?.bw || 250000},RESOLUTION=${tier === 'source' ? `${stream.width}x${stream.height}` : `${Math.round(((stream.width / stream.height) * res.height) / 2) * 2}x${res.height}`}\n${relative}\n`;
        })
        .join('');
    fs.writeFileSync(masterFile, master);
    output.hls = await store.upload(`${prefix}/master-${revision}.m3u8`, masterFile);
    await publish(
      output,
      targets.every((tier) => output.sources[tier]),
    );
    changed = false;
  };
  for (const tier of targets) {
    if (
      output.sources[tier] &&
      output.playlists[tier] &&
      (
        await Promise.all(
          [output.sources[tier], output.playlists[tier], ...(output.segments[tier] || [])].map((key) =>
            store.head(key),
          ),
        )
      ).every(Boolean)
    )
      continue;
    if (budgetExceeded()) break;
    const res = ALL_RES.find((r) => r.name === tier);
    const file = path.join(directory, `${tier}.mp4`),
      playlist = path.join(directory, `${tier}.m3u8`);
    const height = res?.height || stream.height;
    const encoding = compressed
      ? [
          '-vf',
          `scale=-2:${height},fps=${config.fps}`,
          '-c:v',
          'libx264',
          '-crf',
          String(config.crf),
          '-preset',
          config.preset,
          '-c:a',
          'aac',
          '-b:a',
          config.audioBitrate,
        ]
      : ['-c', 'copy'];
    await runProcess(
      'ffmpeg',
      ['-i', source, ...encoding, '-map_metadata', '-1', '-movflags', '+faststart', '-y', file],
      { timeoutMs: job.config.media.timeoutMinutes * 60000, signal },
    );
    await runProcess(
      'ffmpeg',
      [
        '-i',
        file,
        '-c',
        'copy',
        '-hls_time',
        String(config.segmentSeconds),
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        path.join(directory, `${tier}-%05d.ts`),
        '-y',
        playlist,
      ],
      { signal },
    );
    const segments = [];
    for (const name of fs.readdirSync(directory).filter((name) => name.startsWith(`${tier}-`) && name.endsWith('.ts')))
      segments.push(await store.upload(`${prefix}/${name}`, path.join(directory, name)));
    const playlistKey = await store.upload(`${prefix}/${tier}.m3u8`, playlist);
    const sourceKey = await store.upload(`${prefix}/${tier}.mp4`, file);
    output.sources[tier] = sourceKey;
    output.playlists[tier] = playlistKey;
    output.segments[tier] = segments;
    changed = true;
    completed++;
    if (completed % config.uploadAfterTiers === 0) await commit();
  }
  if (changed || !job.checkpoint.hls) await commit();
  return targets.every((tier) => output.sources[tier]);
}
