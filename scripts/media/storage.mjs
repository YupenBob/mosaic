import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { CONTENT_TYPES } from '../../shared/media-manifest.mjs';
export function createStorage(config, env = process.env) {
  const endpoint =
    env.R2_ENDPOINT ||
    config.mediaSource.endpoint ||
    (env.CF_ACCOUNT_ID ? `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
  if (!endpoint || !env.R2_ACCESS_KEY || !env.R2_SECRET_KEY)
    throw new Error('Explicit R2 credentials and endpoint are required');
  const client = new S3Client({
    endpoint,
    region: 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY },
  });
  const Bucket = config.mediaSource.bucket;
  return {
    async head(Key) {
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { etag: object.ETag?.replace(/"/g, ''), size: object.ContentLength };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async get(Key) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key }));
      return { etag: object.ETag?.replace(/"/g, ''), body: object.Body, text: () => object.Body.transformToString() };
    },
    async download(Key, file, etag, { signal } = {}) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key, ...(etag ? { IfMatch: etag } : {}) }), {
        abortSignal: signal,
      });
      await pipeline(object.Body, fs.createWriteStream(file), { signal });
    },
    async upload(Key, file) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: fs.createReadStream(file),
          ContentType: CONTENT_TYPES[file.split('.').pop().toLowerCase()] || 'application/octet-stream',
          CacheControl: config.media.cacheControl,
        }),
      );
      const object = await this.head(Key);
      if (!object || object.size !== fs.statSync(file).size) throw new Error(`Upload verification failed: ${Key}`);
      return Key;
    },
    async putJSON(Key, value) {
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: JSON.stringify(value),
          ContentType: 'application/json',
          CacheControl: 'no-store',
        }),
      );
    },
    async *list(prefix) {
      let cursor;
      do {
        const result = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: cursor }),
        );
        for (const object of result.Contents || [])
          yield {
            key: object.Key,
            etag: object.ETag?.replace(/"/g, ''),
            size: object.Size,
            uploaded: object.LastModified,
          };
        cursor = result.NextContinuationToken;
      } while (cursor);
    },
    async delete(keys) {
      for (let start = 0; start < keys.length; start += 1000) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })) },
          }),
        );
        if (result.Errors?.length) throw new Error('R2 cleanup failed');
      }
    },
  };
}
