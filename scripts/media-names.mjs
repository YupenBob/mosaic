/**
 * Shared media output-name helpers for compress.js + generate.js.
 *
 * Both scripts must derive identical names so manifest keys and output
 * filenames line up across cache-hit builds.
 */
import path from 'node:path';

/**
 * Derive the output base name for a video file. Non-ASCII / special
 * characters are stripped (outputs are uploaded to R2 with ASCII names);
 * collisions within the same post are disambiguated with a numeric suffix.
 * Callers must iterate videos in sorted order and share one `seen` set.
 */
export function videoBase(file, seen = new Set()) {
  const raw = path.parse(file).name;
  const base = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'video';
  let candidate = base;
  let i = 2;
  while (seen.has(candidate)) candidate = `${base}-${i++}`;
  seen.add(candidate);
  return candidate;
}
