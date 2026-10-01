import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { extractMusicMeta, extractMusicCover } from '../music-meta.mjs';
export async function waveformFromFile(file, buckets) {
  const samples = Math.floor(fs.statSync(file).size / 2),
    per = Math.max(1, Math.ceil(samples / buckets));
  const peaks = Array(buckets).fill(0);
  let index = 0,
    remainder = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(file)) {
    const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const count = bytes.length - (bytes.length % 2);
    for (let offset = 0; offset < count; offset += 2) {
      const bucket = Math.floor(index++ / per);
      peaks[bucket] = Math.max(peaks[bucket], Math.abs(bytes.readInt16LE(offset)) / 32768);
    }
    remainder = bytes.subarray(count);
  }
  return peaks;
}
export async function processAudio({ source, directory, job, store, prefix, publish, signal }) {
  const sources = {};
  const meta = await extractMusicMeta(source);
  const metadataArgs = ['title', 'artist', 'album']
    .filter((key) => meta[key])
    .flatMap((key) => ['-metadata', `${key}=${meta[key]}`]);
  for (const bitrate of job.config.media.audio.bitrates) {
    const file = path.join(directory, `${bitrate}.mp3`);
    await runProcess(
      'ffmpeg',
      ['-i', source, '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, '-map_metadata', '-1', ...metadataArgs, '-y', file],
      { signal },
    );
    sources[bitrate] = await store.upload(`${prefix}/${bitrate}.mp3`, file);
  }
  const pcmFile = path.join(directory, 'waveform.pcm');
  await runProcess(
    'ffmpeg',
    ['-i', source, '-vn', '-ac', '1', '-ar', String(job.config.media.audio.sampleRate), '-f', 's16le', '-y', pcmFile],
    { signal },
  );
  const waveform = await waveformFromFile(pcmFile, job.config.media.audio.waveformBuckets);
  const coverFile = path.join(directory, 'cover.jpg');
  const cover = (await extractMusicCover(source, coverFile))
    ? await store.upload(`${prefix}/cover.jpg`, coverFile)
    : '';
  const waveformFile = path.join(directory, 'waveform.json');
  fs.writeFileSync(waveformFile, JSON.stringify(waveform));
  await store.upload(`${prefix}/waveform.json`, waveformFile);
  await publish({ ...meta, cover, sources, waveform }, true);
  return true;
}
