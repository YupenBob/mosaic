import crypto from 'node:crypto';
import fs from 'node:fs';
import { JobsDurableObject } from '../../worker/src/jobs-do.js';
import { normalizeConfig, processingConfig } from '../../shared/config.mjs';
import { assetId, fingerprint } from '../../shared/media-manifest.mjs';
export class MemoryBucket {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, options = {}) {
    if (options.onlyIf?.etagMatches && this.objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const body =
      typeof value === 'string'
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(await new Response(value).arrayBuffer());
    const object = {
      key,
      body,
      etag: crypto.createHash('md5').update(body).digest('hex'),
      size: body.length,
      httpMetadata: options.httpMetadata || {},
      uploaded: new Date(),
    };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object
      ? { ...object, body: new Response(object.body).body, text: async () => object.body.toString() }
      : null;
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { ...object, body: undefined } : null;
  }
  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
  async list({ prefix = '' } = {}) {
    return { objects: [...this.objects.values()].filter((object) => object.key.startsWith(prefix)), truncated: false };
  }
}
export function createRuntime() {
  const bucket = new MemoryBucket(),
    persistent = new Map();
  let alarmAt = null;
  const storage = {
    get: async (key) => structuredClone(persistent.get(key)),
    put: async (key, value) => {
      const values = typeof key === 'object' ? Object.values(key) : [value];
      if (values.some((item) => Buffer.byteLength(JSON.stringify(item)) > 128 * 1024))
        throw new Error('Durable Object record exceeds 128 KiB');
      if (typeof key === 'object')
        for (const [name, item] of Object.entries(key)) persistent.set(name, structuredClone(item));
      else persistent.set(key, structuredClone(value));
    },
    list: async ({ prefix = '', limit = 1000, startAfter = '' } = {}) =>
      new Map(
        [...persistent.entries()]
          .filter(([key]) => key.startsWith(prefix) && key > startAfter)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)]),
      ),
    getAlarm: async () => alarmAt,
    setAlarm: async (value) => {
      alarmAt = value;
    },
    deleteAlarm: async () => {
      alarmAt = null;
    },
    transaction: async (work) => {
      const before = structuredClone(persistent),
        previousAlarm = alarmAt;
      try {
        return await work(storage);
      } catch (error) {
        persistent.clear();
        for (const [key, value] of before) persistent.set(key, value);
        alarmAt = previousAlarm;
        throw error;
      }
    },
  };
  const config = normalizeConfig({
    media: { debounceMs: 0, retryMs: 0, leaseMs: 120000 },
    videoQuality: { maxHeight: 480, preset: 'ultrafast' },
  });
  const env = {
    MEDIA: bucket,
    GITHUB_REPO: 'test/mosaic',
    GITHUB_TOKEN: 'mock',
    PIPELINE_SECRET: 'integration-only-secret',
  };
  let coordinator = new JobsDurableObject({ storage }, env);
  env.JOBS = { idFromName: (name) => name, get: () => ({ fetch: (request) => coordinator.fetch(request) }) };
  const call = async (operation, data = {}) => {
    const response = await coordinator.fetch(
      new Request(`https://jobs.local/${operation}`, { method: 'POST', body: JSON.stringify(data) }),
    );
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  };
  return {
    env,
    bucket,
    config,
    storage,
    persistent,
    call,
    alarm: () => coordinator.alarm(),
    restart: () => {
      coordinator = new JobsDurableObject({ storage }, env);
    },
    async enqueue(slug, filename, bytes = Buffer.from('source'), patch = {}) {
      const folder =
        patch.folder || (filename.endsWith('.mp4') ? 'videos' : filename.endsWith('.flac') ? 'music' : 'photos');
      const key = `originals/${slug}/${folder}/${filename}`;
      const object = await bucket.put(key, bytes);
      return call('enqueue', {
        id: assetId(slug, filename, folder),
        slug,
        filename,
        folder,
        source: { key, etag: object.etag, size: object.size },
        config,
        configHash: await fingerprint(processingConfig(config, folder)),
        ...patch,
      });
    },
    store: {
      head: (key) => bucket.head(key),
      get: async (key) => {
        const object = await bucket.get(key);
        if (!object) throw new Error('Missing object');
        return object;
      },
      async *list(prefix) {
        for (const object of (await bucket.list({ prefix })).objects) yield object;
      },
      download: async (key, file, etag) => {
        const object = bucket.objects.get(key);
        if (object?.etag !== etag) throw new Error('Source precondition failed');
        fs.writeFileSync(file, object.body);
      },
      upload: async (key, file) => {
        await bucket.put(key, fs.readFileSync(file));
        return key;
      },
      delete: (keys) => bucket.delete(keys),
    },
  };
}
