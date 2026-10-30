/**
 * Pure Media v2 migration planner.
 *
 * Given a v1/mixed manifest and the current posts' frontmatter, produce the v2
 * asset records, the R2 copy plan and the new `media` blocks. No I/O: the CLI
 * applies the plan, tests exercise it on fixtures.
 */
import { objectKeys } from '../../shared/media-manifest.mjs';
import { assetIdFromLegacy, ASSET_ID_RE } from '../../shared/media-v2.mjs';

function mapObject(value, map) {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapObject(item, map));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapObject(item, map)]));
  return value;
}

function mapKey(asset, newId, key) {
  if (typeof key !== 'string') return key;
  const oldPrefix = `originals/${asset.slug}/`;
  if (key.startsWith(oldPrefix)) return `originals/assets/${newId}/${asset.filename}`;
  const processed = `processed/${asset.slug}/`;
  if (key.startsWith(processed)) {
    const rest = key.slice(processed.length);
    const afterFolder = rest.split('/').slice(1).join('/');
    return `processed/assets/${newId}/${afterFolder}`;
  }
  return key;
}

/**
 * @param {{manifest:object, posts:Array<{slug:string, frontMatter?:object}>}} input
 */
export async function planV2Migration({ manifest, posts = [] }) {
  const legacyAssets = Object.values(manifest.assets).filter(
    (asset) => asset.status !== 'deleted' && !asset.v2 && !ASSET_ID_RE.test(asset.id),
  );
  const idByLegacy = new Map();
  for (const asset of legacyAssets) idByLegacy.set(asset.id, await assetIdFromLegacy(asset.id));

  const assets = [];
  const copies = [];
  for (const asset of legacyAssets) {
    const id = idByLegacy.get(asset.id);
    const map = (key) => mapKey(asset, id, key);
    const source = { ...asset.source, key: map(asset.source.key) };
    const published = asset.published ? mapObject(asset.published, map) : null;
    const oldKeys = new Set([asset.source.key, ...(asset.published ? objectKeys(asset.published) : [])]);
    const newKeys = new Set([source.key, ...(published ? objectKeys(published) : [])]);
    for (const oldKey of oldKeys) {
      const newKey = map(oldKey);
      if (newKey !== oldKey) copies.push({ from: oldKey, to: newKey });
    }
    assets.push({
      ...asset,
      id,
      v2: true,
      slug: null,
      source,
      published,
      legacy: { id: asset.id, slug: asset.slug },
      lifecycle: {
        state: published ? 'ready' : 'processing',
        uploadedAt: asset.createdAt || null,
        firstPublishedAt: null,
        lastPublishedAt: null,
        lastUsedAt: null,
        unusedSince: null,
        archivedAt: null,
        deletedAt: null,
        purgeAfter: null,
        previousState: null,
        health: { level: 'ok', reasons: [] },
      },
    });
    // Ensure every copied target is accounted for, even when keys collide.
    for (const key of newKeys) if (!copies.some((copy) => copy.to === key)) copies.push({ from: '', to: key });
  }

  const byLegacy = new Map(assets.map((asset) => [asset.legacy.id, asset]));
  const migratedPosts = posts.map((post) => {
    const frontMatter = post.frontMatter || {};
    if (frontMatter.media && typeof frontMatter.media === 'object')
      return { slug: post.slug, media: frontMatter.media };
    const forPost = assets.filter((asset) => asset.legacy.slug === post.slug);
    const byFolder = (folder) => forPost.filter((asset) => asset.folder === folder);
    const photos = byFolder('photos');
    const videos = byFolder('videos');
    const music = byFolder('music');
    const covers = byFolder('covers');
    const coverRef = String(frontMatter.cover || '');
    let cover = null;
    const indexed = /^(photo|video):(\d+)$/.exec(coverRef);
    if (indexed) {
      const list = indexed[1] === 'video' ? videos : photos;
      cover = list[Number(indexed[2])]?.id || null;
    } else if (coverRef) {
      cover =
        covers.find((asset) => asset.filename === coverRef)?.id ||
        photos.find((asset) => asset.filename === coverRef)?.id ||
        null;
    }
    return {
      slug: post.slug,
      media: {
        gallery: photos.map((asset) => asset.id),
        videos: videos.map((asset) => asset.id),
        music: music.map((asset) => asset.id),
        cover,
      },
    };
  });

  return {
    assets,
    copies,
    posts: migratedPosts,
    byLegacy,
    counts: {
      assets: assets.length,
      copies: copies.filter((copy) => copy.from).length,
      posts: migratedPosts.length,
      references: migratedPosts.reduce(
        (total, post) =>
          total +
          post.media.gallery.length +
          post.media.videos.length +
          post.media.music.length +
          (post.media.cover ? 1 : 0),
        0,
      ),
    },
  };
}
