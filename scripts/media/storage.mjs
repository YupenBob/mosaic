import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { CONTENT_TYPES } from '../../shared/media-manifest.mjs';

/** S3/R2 minimum size of a multipart part (all but the final part). */
export const MIN_PART_BYTES = 5242880;
/** S3 hard limit on parts per multipart upload. */
export const MAX_PARTS = 10000;

const DEFAULT_MULTIPART_THRESHOLD = 104857600;
const DEFAULT_PART_SIZE = 8388608;
const DEFAULT_UPLOAD_RETRIES = 3;

/**
 * Transient failures worth retrying: network errors without an HTTP status,
 * 5xx, 429 and 408. Client errors (4xx) are permanent.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableUploadError(error) {
  const status = /** @type {{$metadata?: {httpStatusCode?: number}}} */ (error)?.$metadata?.httpStatusCode;
  if (status === undefined || status === null) return true;
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Number of parts for an object of `size` bytes and `partSize`-sized chunks.
 * @param {number} size
 * @param {number} partSize
 * @returns {number}
 */
export function multipartPartCount(size, partSize) {
  return Math.min(MAX_PARTS, Math.max(1, Math.ceil(size / partSize)));
}

/**
 * Part count encoded in a multipart ETag (`"<md5-of-md5s>-<parts>"`).
 * @param {string|undefined} etag
 * @returns {number|null} null when the ETag has no part suffix
 */
export function multipartEtagPartCount(etag) {
  const match = /-(\d+)$/.exec(String(etag || '').replace(/"/g, ''));
  return match ? Number(match[1]) : null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the R2 storage adapter used by the media runner.
 *
 * Uploads above `media.multipartThreshold` bytes use S3 multipart with
 * `media.partSize` chunks and `media.uploadRetries` retries per request; every
 * upload is HEAD-verified (size, plus multipart ETag part count on completion).
 * A failed multipart upload is always aborted so no orphan parts linger.
 *
 * @param {object} config - normalized site config
 * @param {Record<string, string|undefined>} [env] - explicit environment
 * @param {{client?: object, retryDelayMs?: number, sleep?: (ms:number)=>Promise<void>}} [options]
 *   `client` injects a fake/alternate S3 client (tests bypass credentials);
 *   `retryDelayMs` scales the exponential backoff (0 disables the wait).
 */
export function createStorage(config, env = process.env, options = {}) {
  let client = options.client;
  if (!client) {
    const endpoint =
      env.R2_ENDPOINT ||
      config.mediaSource.endpoint ||
      (env.CF_ACCOUNT_ID ? `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
    if (!endpoint || !env.R2_ACCESS_KEY || !env.R2_SECRET_KEY)
      throw new Error('Explicit R2 credentials and endpoint are required');
    client = new S3Client({
      endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: env.R2_ACCESS_KEY, secretAccessKey: env.R2_SECRET_KEY },
    });
  }
  const Bucket = config.mediaSource.bucket;
  const media = config.media || {};
  const multipartThreshold = Number.isFinite(media.multipartThreshold)
    ? media.multipartThreshold
    : DEFAULT_MULTIPART_THRESHOLD;
  const partSize = Number.isFinite(media.partSize) && media.partSize > 0 ? media.partSize : DEFAULT_PART_SIZE;
  const uploadRetries = Number.isInteger(media.uploadRetries)
    ? Math.max(0, media.uploadRetries)
    : DEFAULT_UPLOAD_RETRIES;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 200;
  const wait = options.sleep || sleep;

  /**
   * Run `operation` with bounded retries on transient failures. The operation
   * receives the zero-based attempt number so callers can rebuild bodies.
   * @template T
   * @param {string} label
   * @param {(attempt: number) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async function sendWithRetry(label, operation) {
    let lastError;
    for (let attempt = 0; attempt <= uploadRetries; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        if (!isRetryableUploadError(error) || attempt === uploadRetries) throw error;
        console.warn(`Upload ${label} attempt ${attempt + 1} failed, retrying: ${error.message}`);
        if (retryDelayMs > 0) await wait(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  /** @param {string} file */
  function contentTypeFor(file) {
    return CONTENT_TYPES[file.split('.').pop().toLowerCase()] || 'application/octet-stream';
  }

  /** HEAD one object; returns `{etag, size}` or null when absent. */
  async function headObject(Key) {
    try {
      const object = await client.send(new HeadObjectCommand({ Bucket, Key }));
      return { etag: object.ETag?.replace(/"/g, ''), size: object.ContentLength };
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  /** HEAD the object and assert its size (and multipart part count when known). */
  async function verifyUpload(Key, expectedSize, expectedParts) {
    const object = await headObject(Key);
    if (!object) throw new Error(`Upload verification failed: ${Key}`);
    if (object.size !== expectedSize)
      throw new Error(`Upload verification failed: ${Key} size ${object.size} != ${expectedSize}`);
    if (expectedParts !== undefined) {
      const actualParts = multipartEtagPartCount(object.etag);
      if (actualParts !== expectedParts)
        throw new Error(`Upload verification failed: ${Key} parts ${actualParts} != ${expectedParts}`);
    }
  }

  /**
   * S3 multipart upload of one local file. Parts are read sequentially into a
   * bounded buffer; on any failure the upload is aborted before rethrowing.
   */
  async function uploadMultipart(Key, file, size, { signal } = {}) {
    const ContentType = contentTypeFor(file);
    // Keep the part count under the S3 limit even for oversized files: grow the
    // chunk instead of silently dropping the tail.
    const chunkSize = Math.max(partSize, Math.ceil(size / MAX_PARTS));
    const partCount = multipartPartCount(size, chunkSize);
    const created = await sendWithRetry('multipart-create', () =>
      client.send(
        new CreateMultipartUploadCommand({
          Bucket,
          Key,
          ContentType,
          CacheControl: config.media.cacheControl,
        }),
        { abortSignal: signal },
      ),
    );
    const UploadId = created?.UploadId;
    if (!UploadId) throw new Error(`Multipart upload creation failed: ${Key}`);
    try {
      const handle = await fs.promises.open(file, 'r');
      const parts = [];
      try {
        const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, size)));
        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
          const start = (partNumber - 1) * chunkSize;
          const length = Math.min(chunkSize, size - start);
          const { bytesRead } = await handle.read(buffer, 0, length, start);
          if (bytesRead !== length)
            throw new Error(`Short read for ${Key} part ${partNumber} (${bytesRead}/${length})`);
          const result = await sendWithRetry(`part-${partNumber}`, () =>
            client.send(
              new UploadPartCommand({
                Bucket,
                Key,
                UploadId,
                PartNumber: partNumber,
                Body: buffer.subarray(0, length),
              }),
              { abortSignal: signal },
            ),
          );
          if (!result?.ETag) throw new Error(`Missing ETag for ${Key} part ${partNumber}`);
          parts.push({ ETag: result.ETag, PartNumber: partNumber });
        }
      } finally {
        await handle.close();
      }
      await sendWithRetry('multipart-complete', () =>
        client.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId,
            MultipartUpload: { Parts: parts },
          }),
          { abortSignal: signal },
        ),
      );
      await verifyUpload(Key, size, partCount);
    } catch (error) {
      // Never leave orphaned parts behind: abort best-effort, keep the cause.
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
      } catch (abortError) {
        console.warn(`Multipart abort failed for ${Key}: ${abortError.message}`);
      }
      throw error;
    }
  }

  /** Single PUT upload with 5xx retries and size verification. */
  async function uploadSingle(Key, file, size, { signal } = {}) {
    await sendWithRetry('put', () =>
      client.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: fs.createReadStream(file),
          ContentType: contentTypeFor(file),
          CacheControl: config.media.cacheControl,
        }),
        { abortSignal: signal },
      ),
    );
    await verifyUpload(Key, size);
  }

  const store = {
    head: headObject,
    async get(Key) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key }));
      return { etag: object.ETag?.replace(/"/g, ''), body: object.Body, text: () => object.Body.transformToString() };
    },
    async download(Key, file, etag, { signal } = {}) {
      const object = await client.send(
        new GetObjectCommand({ Bucket, Key, ...(etag ? { IfMatch: `"${etag.replace(/"/g, '')}"` } : {}) }),
        {
          abortSignal: signal,
        },
      );
      await pipeline(object.Body, fs.createWriteStream(file), { signal });
    },
    /**
     * Upload one local file. Objects above `media.multipartThreshold` use S3
     * multipart; everything else is a single PUT. Both paths retry transient
     * failures and HEAD-verify the stored object before resolving.
     * @param {string} Key
     * @param {string} file
     * @param {{signal?: AbortSignal}} [uploadOptions]
     * @returns {Promise<string>} the object key
     */
    async upload(Key, file, uploadOptions = {}) {
      const size = fs.statSync(file).size;
      if (size > multipartThreshold) await uploadMultipart(Key, file, size, uploadOptions);
      else await uploadSingle(Key, file, size, uploadOptions);
      return Key;
    },
    async copy(From, To) {
      await client.send(
        new CopyObjectCommand({
          Bucket,
          CopySource: `${Bucket}/${From.split('/').map(encodeURIComponent).join('/')}`,
          Key: To,
          MetadataDirective: 'COPY',
        }),
      );
      const object = await this.head(To);
      if (!object) throw new Error(`Copy verification failed: ${To}`);
      return To;
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
  return store;
}
