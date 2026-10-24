/**
 * Thin ffmpeg/ffprobe I/O helpers for video processing. Kept separate from the
 * pipeline orchestration so encoding arguments (see `video-filter.mjs`) stay
 * pure and unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.mjs';

/**
 * Probe a media file with ffprobe.
 * @param {string} source - local file path
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{stream: object, format: object, width: number, height: number, duration: number, aspect: number}>}
 */
export async function probeVideo(source, { signal } = {}) {
  const output = await runProcess('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], {
    capture: true,
    signal,
  });
  const info = JSON.parse(output.toString());
  const stream = info.streams.find((candidate) => candidate.codec_type === 'video');
  if (!stream?.height) throw new Error('Video has no decodable video stream');
  const width = Number(stream.width) || 0;
  const height = Number(stream.height);
  return {
    stream,
    format: info.format || {},
    width,
    height,
    duration: Number(info.format?.duration) || 0,
    aspect: width ? width / height : 0,
  };
}

/**
 * Extract a single poster frame as JPEG at `at` seconds.
 * @param {object} options
 * @param {string} options.input - local video file
 * @param {string} options.output - local JPEG path
 * @param {number} options.at - seek position in seconds
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function extractPoster({ input, output, at, signal }) {
  await runProcess(
    'ffmpeg',
    ['-i', input, '-ss', String(Math.max(0, at)), '-frames:v', '1', '-vf', 'scale=-2:720', '-y', output],
    { signal },
  );
}

/**
 * Re-encode one tier in a single ffmpeg pass (filter + H.264 + AAC).
 * @param {object} options
 * @param {string} options.input - local input video
 * @param {string} options.output - local output mp4 path
 * @param {string[]} options.args - encoding args from `buildEncodeArgs`
 * @param {number} [options.timeoutMs] - hard process timeout
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function encodeTier({ input, output, args, timeoutMs, signal }) {
  await runProcess('ffmpeg', ['-i', input, ...args, '-map_metadata', '-1', '-movflags', '+faststart', '-y', output], {
    timeoutMs,
    signal,
  });
}

/**
 * Segment a tier mp4 into an HLS playlist plus MPEG-TS fragments (stream copy).
 * @param {object} options
 * @param {string} options.input - local tier mp4
 * @param {string} options.playlist - local output m3u8 path
 * @param {string} options.segmentPattern - local output `%05d.ts` pattern
 * @param {number} options.segmentSeconds - target fragment duration
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function segmentTier({ input, playlist, segmentPattern, segmentSeconds, signal }) {
  await runProcess(
    'ffmpeg',
    [
      '-i',
      input,
      '-c',
      'copy',
      '-hls_time',
      String(segmentSeconds),
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      segmentPattern,
      '-y',
      playlist,
    ],
    { signal },
  );
}

/**
 * Names of the HLS fragments written for a tier by `segmentTier`.
 * @param {string} directory - working directory
 * @param {string} tier - tier name
 * @returns {string[]}
 */
export function segmentFiles(directory, tier) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(`${tier}-`) && name.endsWith('.ts'))
    .sort();
}

/**
 * Remove local tier artifacts after they have been uploaded to keep the media
 * worker's temp directory small during multi-tier interpolation.
 * @param {string} directory
 * @param {string} tier
 */
export function cleanupTierFiles(directory, tier) {
  for (const name of fs.readdirSync(directory)) {
    if (name === `${tier}.mp4` || name === `${tier}.m3u8` || (name.startsWith(`${tier}-`) && name.endsWith('.ts')))
      fs.rmSync(path.join(directory, name), { force: true });
  }
}
