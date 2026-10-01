/** Media identities and published manifests; no filesystem or SDK dependencies. */
export const MANIFEST_VERSION = 1;
export const FOLDERS = {
  photos: ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'gif', 'svg', 'avif'],
  videos: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'],
  music: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'],
};
export const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  json: 'application/json',
  ico: 'image/x-icon',
};
export function validSegment(value) {
  return (
    typeof value === 'string' &&
    !!value &&
    !/[\/\\]/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32) &&
    !['.', '..'].includes(value)
  );
}
export function folderFor(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return Object.keys(FOLDERS).find((folder) => FOLDERS[folder].includes(ext)) || 'others';
}
export function assetId(slug, filename, folder = folderFor(filename)) {
  if (
    !validSegment(slug) ||
    !validSegment(filename) ||
    !['photos', 'videos', 'music', 'covers', 'others'].includes(folder)
  )
    throw new Error('Invalid media name');
  return `${slug}/${folder}/${filename}`;
}
export function emptyManifest() {
  return { schemaVersion: MANIFEST_VERSION, revision: 0, assets: {} };
}
export function validateManifest(value) {
  if (
    value?.schemaVersion !== MANIFEST_VERSION ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !value.assets ||
    Array.isArray(value.assets)
  )
    throw new Error('Unsupported or corrupt media manifest');
  for (const [id, entry] of Object.entries(value.assets)) {
    if (id !== assetId(entry.slug, entry.filename, entry.folder)) throw new Error('Invalid media manifest identity');
  }
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export async function fingerprint(value) {
  const data = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function mediaUrl(key, base = '') {
  if (!key) return '';
  return `${base.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
export function objectKeys(published) {
  const result = new Set();
  const walk = (value) => {
    if (typeof value === 'string' && /^(processed|originals)\//.test(value)) result.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(published);
  return [...result];
}
