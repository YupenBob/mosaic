/**
 * Shared helpers for the operational scripts under `scripts/ops/`.
 *
 * Deliberately tiny: argument parsing, dry-run/apply semantics, friendly
 * credential errors and two thin clients (Cloudflare REST, R2 via the S3 API).
 * Every script must be safe to run locally with `--dry-run` and no credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../lib/context.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Parse `--flag`, `--key=value` and `--key value` arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      values[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[body] = next;
      index++;
    } else flags.add(body);
  }
  return { flags, values, positionals };
}

/** Destructive work only happens with an explicit `--apply` (or MOSAIC_APPLY=true). */
export function isApply(args) {
  return args.flags.has('apply') || process.env.MOSAIC_APPLY === 'true';
}

/** Load repository configuration (throws a readable error when it is invalid). */
export function loadConfig() {
  return loadContext();
}

/** Fail with a friendly message instead of a stack trace; exit code 2 = unusable environment. */
export function fatal(message, code = 2) {
  console.error(`error: ${message}`);
  process.exit(code);
}

export function requireEnv(names, hint = '') {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length)
    fatal(
      `missing credentials: ${missing.join(', ')}${hint ? `\n  ${hint}` : ''}\n  (scripts accept --dry-run without credentials where the plan is computable)`,
    );
}

/** Media origin (no trailing slash) from MEDIA_URL or the configured mediaBase. */
export function mediaOrigin(config, env = process.env) {
  const explicit = env.MEDIA_URL || env.MEDIA_ORIGIN;
  const base = explicit || config?.mediaBase || '';
  if (!base) fatal('MEDIA_URL is required (or set mediaBase in mosaic.config.json)');
  return base.replace(/\/+$/, '');
}

/** Cloudflare token/account pair for account-scoped APIs. */
export function cloudflareAccount() {
  requireEnv(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], 'needed for account-scoped Cloudflare APIs');
  return { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
}

/**
 * Call the Cloudflare REST API and surface `success:false` as an error.
 * @param {{token:string, url:string, method?:string, body?:object, allow404?:boolean}} options
 */
export async function cloudflareJson({ token, url, method = 'GET', body, allow404 = false }) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (allow404 && response.status === 404) return { ok: false, status: 404, data };
  if (!response.ok || (data && data.success === false)) {
    const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data?.errors || data).slice(0, 300);
    const error = new Error(`Cloudflare ${method} ${new URL(url).pathname}: ${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }
  return { ok: true, status: response.status, data };
}

/**
 * R2 access through the existing storage adapter. Requires explicit
 * R2_ACCESS_KEY / R2_SECRET_KEY / endpoint; otherwise the friendly
 * credential error is raised. The adapter (and its S3 SDK) is imported lazily so
 * scripts that never touch R2 still run on a bare checkout (rollback, deploy).
 */
export async function r2Storage(config = loadConfig().config) {
  const { createStorage } = await import('../media/storage.mjs');
  return createStorage(config);
}

/** Log one line prefixed with the execution mode so logs are self-describing. */
export function log(mode, message) {
  console.log(`[${mode}] ${message}`);
}

export function modeLabel(apply) {
  return apply ? 'apply' : 'dry-run';
}

/** Format a byte count for operator output. */
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Recursively list files (used by preview cleanup/reporters). */
export function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export function ageDays(date) {
  return (Date.now() - new Date(date).getTime()) / 86400000;
}
