/**
 * R2 operation helpers.
 * Uses S3-compatible API via @aws-sdk for presigned URLs and direct bucket binding for operations.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env, MediaFile } from '../types';

/**
 * Generate a presigned PUT URL for direct-to-R2 upload from the client.
 */
export async function generatePresignedUrl(
  env: Env,
  key: string,
  contentType: string
): Promise<string> {
  // Use the S3 client if credentials are available, otherwise use a simpler approach
  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_PUBLIC_URL
      ? new URL(env.R2_PUBLIC_URL).origin
      : `https://${env.MEDIA}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: '', // Will be set from env
      secretAccessKey: '',
    },
  });

  const command = new PutObjectCommand({
    Bucket: 'mosaic-media',
    Key: key,
    ContentType: contentType,
  });

  return getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
}

/**
 * Delete a single object from R2.
 */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.MEDIA.delete(key);
}

/**
 * Delete multiple objects from R2.
 */
export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => env.MEDIA.delete(key)));
}

/**
 * List all media objects for a given post slug.
 */
export async function listMediaObjects(
  env: Env,
  slug: string
): Promise<{ photos: MediaFile[]; videos: MediaFile[]; music: MediaFile[]; covers: MediaFile[] }> {
  const result = { photos: [] as MediaFile[], videos: [] as MediaFile[], music: [] as MediaFile[], covers: [] as MediaFile[] };

  const prefixes = [
    { prefix: `originals/${slug}/photos/`, type: 'photos' as const },
    { prefix: `originals/${slug}/videos/`, type: 'videos' as const },
    { prefix: `originals/${slug}/music/`, type: 'music' as const },
    { prefix: `processed/${slug}/covers/`, type: 'covers' as const },
  ];

  for (const { prefix, type } of prefixes) {
    const objects = await env.MEDIA.list({ prefix, limit: 500 });
    for (const obj of objects.objects) {
      const name = obj.key.split('/').pop() || obj.key;
      result[type].push({
        name,
        size: obj.size,
        lastModified: obj.uploaded.toISOString(),
        url: `${env.R2_PUBLIC_URL}/${obj.key}`,
        processed: obj.key.startsWith('processed/'),
      });
    }
  }

  return result;
}

/**
 * Build the R2 object key for a given path.
 */
export function buildKey(
  slug: string,
  category: 'originals' | 'processed',
  type: 'photos' | 'videos' | 'music' | 'covers',
  filename: string
): string {
  return `${category}/${slug}/${type}/${filename}`;
}

/**
 * Check if an object exists in R2.
 */
export async function objectExists(env: Env, key: string): Promise<boolean> {
  const obj = await env.MEDIA.head(key);
  return obj !== null;
}
