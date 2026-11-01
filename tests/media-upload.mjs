/**
 * Server-side media upload adapter: small-object PUT, >threshold multipart with
 * bounded part retries, abort on failure and HEAD verification (size + ETag
 * part count). Uses an injected fake S3 client, so no network/AWS is needed.
 *
 * Run: node tests/media-upload.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createStorage, multipartEtagPartCount, multipartPartCount } from '../scripts/media/storage.mjs';

/** Read a command body (Buffer, string or stream) into a Buffer. */
async function bodyBuffer(body) {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

/** Minimal in-memory S3 client with command recording and failure injection. */
class FakeS3Client {
  constructor() {
    this.commands = [];
    this.objects = new Map();
    this.uploads = new Map();
    this.aborted = [];
    this.failures = [];
    this.nextUploadId = 1;
    this.sizeOverride = undefined;
    this.etagOverride = undefined;
  }

  /** Fail the next `times` matching sends with an HTTP status (default 503). */
  failNext(name, { times = 1, status = 503, partNumber } = {}) {
    this.failures.push({ name, remaining: times, status, partNumber });
  }

  #takeFailure(name, input) {
    const failure = this.failures.find(
      (entry) =>
        entry.name === name &&
        entry.remaining > 0 &&
        (entry.partNumber === undefined || entry.partNumber === input.PartNumber),
    );
    if (!failure) return null;
    failure.remaining--;
    const error = new Error(`${name} rejected with ${failure.status}`);
    error.$metadata = { httpStatusCode: failure.status };
    return error;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    this.commands.push({ name, input });
    const failure = this.#takeFailure(name, input);
    if (failure) throw failure;
    if (command instanceof CreateMultipartUploadCommand) {
      const UploadId = `upload-${this.nextUploadId++}`;
      this.uploads.set(UploadId, { key: input.Key, parts: new Map() });
      return { UploadId };
    }
    if (command instanceof UploadPartCommand) {
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw new Error('NoSuchUpload');
      const body = await bodyBuffer(input.Body);
      upload.parts.set(input.PartNumber, body);
      return { ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw new Error('NoSuchUpload');
      const partNumbers = input.MultipartUpload.Parts.map((part) => part.PartNumber).sort((a, b) => a - b);
      const body = Buffer.concat(partNumbers.map((partNumber) => upload.parts.get(partNumber)));
      const parts = this.etagOverride?.parts ?? partNumbers.length;
      const etag = `${crypto.createHash('md5').update(body).digest('hex')}-${parts}`;
      this.objects.set(input.Key, { body, size: body.length, etag });
      this.uploads.delete(input.UploadId);
      return { ETag: `"${etag}"` };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.aborted.push(input.UploadId);
      this.uploads.delete(input.UploadId);
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) {
        const error = new Error('NotFound');
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ETag: `"${object.etag}"`,
        ContentLength: this.sizeOverride !== undefined ? this.sizeOverride : object.size,
      };
    }
    if (command instanceof PutObjectCommand) {
      const body = await bodyBuffer(input.Body);
      this.objects.set(input.Key, {
        body,
        size: body.length,
        etag: crypto.createHash('md5').update(body).digest('hex'),
      });
      return { ETag: `"${this.objects.get(input.Key).etag}"` };
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }

  count(name) {
    return this.commands.filter((command) => command.name === name).length;
  }

  partsOf(partNumber) {
    return this.commands.filter(
      (command) => command.name === 'UploadPartCommand' && command.input.PartNumber === partNumber,
    );
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-upload-'));
const config = (patch = {}) => ({
  mediaSource: { bucket: 'test-bucket', endpoint: 'https://r2.test' },
  media: {
    cacheControl: 'public, max-age=60',
    multipartThreshold: 100,
    partSize: 64,
    uploadRetries: 2,
    ...patch,
  },
});
const makeFile = (name, size) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return file;
};
const makeStore = (fake, patch = {}) => createStorage(config(patch), {}, { client: fake, retryDelayMs: 0 });

try {
  // ── Part math ──
  assert.equal(multipartPartCount(300, 64), 5);
  assert.equal(multipartPartCount(1, 64), 1);
  assert.equal(multipartEtagPartCount('"abcdef-5"'), 5);
  assert.equal(multipartEtagPartCount('abcdef'), null);

  // ── Credentials are mandatory unless a client is injected ──
  assert.throws(() => createStorage(config(), {}), /credentials and endpoint are required/);

  // ── Small object: one PUT, no multipart, HEAD-verified ──
  {
    const fake = new FakeS3Client();
    const store = makeStore(fake);
    const file = makeFile('small.bin', 50);
    assert.equal(await store.upload('processed/small.bin', file), 'processed/small.bin');
    assert.equal(fake.count('PutObjectCommand'), 1);
    assert.equal(fake.count('CreateMultipartUploadCommand'), 0);
    assert.equal(fake.count('UploadPartCommand'), 0);
    assert.equal(fake.commands.at(-1).name, 'HeadObjectCommand', 'every upload is HEAD-verified');
    assert.deepEqual(fake.objects.get('processed/small.bin').body, fs.readFileSync(file));
  }

  // ── Exactly at the threshold still uses a single PUT ──
  {
    const fake = new FakeS3Client();
    await makeStore(fake).upload('processed/boundary.bin', makeFile('boundary.bin', 100));
    assert.equal(fake.count('PutObjectCommand'), 1);
    assert.equal(fake.count('CreateMultipartUploadCommand'), 0);
  }

  // ── Large object: multipart, ceil(size/partSize) parts, complete then verify ──
  {
    const fake = new FakeS3Client();
    const store = makeStore(fake);
    const file = makeFile('big.bin', 300);
    assert.equal(await store.upload('processed/big.bin', file), 'processed/big.bin');
    assert.equal(fake.count('CreateMultipartUploadCommand'), 1);
    assert.equal(fake.count('UploadPartCommand'), 5);
    assert.deepEqual(
      fake.commands
        .filter((command) => command.name === 'UploadPartCommand')
        .map((command) => command.input.PartNumber),
      [1, 2, 3, 4, 5],
    );
    assert.equal(fake.count('CompleteMultipartUploadCommand'), 1);
    assert.equal(fake.aborted.length, 0);
    assert.equal(fake.commands.at(-1).name, 'HeadObjectCommand');
    const stored = fake.objects.get('processed/big.bin');
    assert.deepEqual(stored.body, fs.readFileSync(file), 'parts are reassembled in order');
    assert.deepEqual(
      fake.commands
        .filter((command) => command.name === 'UploadPartCommand')
        .map((command) => command.input.Body.length),
      [64, 64, 64, 64, 44],
      'every part is partSize bytes except the last remainder',
    );
  }

  // ── A transient part failure is retried with the same part number ──
  {
    const fake = new FakeS3Client();
    fake.failNext('UploadPartCommand', { times: 2, status: 503, partNumber: 2 });
    const store = makeStore(fake);
    await store.upload('processed/retry.bin', makeFile('retry.bin', 300));
    assert.equal(fake.partsOf(2).length, 3, 'one attempt + two retries');
    assert.equal(fake.count('CompleteMultipartUploadCommand'), 1);
    assert.equal(fake.aborted.length, 0);
  }

  // ── Exhausted retries abort the multipart upload and rethrow ──
  {
    const fake = new FakeS3Client();
    fake.failNext('UploadPartCommand', { times: 10, status: 500, partNumber: 3 });
    const store = makeStore(fake);
    await assert.rejects(() => store.upload('processed/abort.bin', makeFile('abort.bin', 300)), /500/);
    assert.equal(fake.partsOf(3).length, 3, 'uploadRetries=2 means three attempts');
    assert.equal(fake.count('CompleteMultipartUploadCommand'), 0);
    assert.equal(fake.aborted.length, 1, 'failed multipart uploads are aborted');
    assert.match(fake.aborted[0], /^upload-\d+$/);
  }

  // ── Non-retryable errors fail fast and still abort ──
  {
    const fake = new FakeS3Client();
    fake.failNext('UploadPartCommand', { times: 1, status: 400, partNumber: 1 });
    const store = makeStore(fake);
    await assert.rejects(() => store.upload('processed/permanent.bin', makeFile('permanent.bin', 300)), /400/);
    assert.equal(fake.partsOf(1).length, 1, '4xx is not retried');
    assert.equal(fake.aborted.length, 1);
  }

  // ── Single PUT retries 5xx and succeeds on a later attempt ──
  {
    const fake = new FakeS3Client();
    fake.failNext('PutObjectCommand', { times: 1, status: 503 });
    const store = makeStore(fake);
    await store.upload('processed/put-retry.bin', makeFile('put-retry.bin', 50));
    assert.equal(fake.count('PutObjectCommand'), 2);
    assert.ok(fake.objects.has('processed/put-retry.bin'));
  }

  // ── Single PUT does not retry permanent client errors ──
  {
    const fake = new FakeS3Client();
    fake.failNext('PutObjectCommand', { times: 1, status: 403 });
    const store = makeStore(fake);
    await assert.rejects(() => store.upload('processed/put-403.bin', makeFile('put-403.bin', 50)), /403/);
    assert.equal(fake.count('PutObjectCommand'), 1);
  }

  // ── HEAD verification rejects a wrong stored size ──
  {
    const fake = new FakeS3Client();
    fake.sizeOverride = 51;
    const store = makeStore(fake);
    await assert.rejects(
      () => store.upload('processed/size.bin', makeFile('size.bin', 50)),
      /Upload verification failed: processed\/size\.bin size 51 != 50/,
    );
  }

  // ── HEAD verification rejects a wrong multipart ETag part count ──
  {
    const fake = new FakeS3Client();
    fake.etagOverride = { parts: 99 };
    const store = makeStore(fake);
    await assert.rejects(
      () => store.upload('processed/parts.bin', makeFile('parts.bin', 300)),
      /Upload verification failed: processed\/parts\.bin parts 99 != 5/,
    );
    assert.equal(fake.aborted.length, 1);
  }

  console.log('Media upload: threshold, multipart part count/order, retries, abort and HEAD verification passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
