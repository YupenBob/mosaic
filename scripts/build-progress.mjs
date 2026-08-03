#!/usr/bin/env node
/**
 * Writes dist/build-progress.json stage markers for the pipeline's background
 * reporter (which uploads the file to R2 every few seconds). Called from
 * pipeline.yml between phases:  node scripts/build-progress.mjs <stage> [message]
 *
 * Preserves media counters (done/total/current) written by compress.js.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'dist', 'build-progress.json');
const [stage = ''] = process.argv.slice(2);

// Built-in Chinese stage messages — pipeline.yml only passes the ASCII stage
// name, so encoding never depends on the shell locale.
const STAGE_MESSAGES = {
  started: '构建已排队，等待开始…',
  media: '正在压缩媒体（图片 / 视频 / 音频）…',
  generate: '正在生成站点…',
  test: '正在运行测试…',
  upload: '正在上传媒体产物到 R2…',
  deploy: '正在部署到 Cloudflare Pages…',
  done: '构建完成',
};
const message = STAGE_MESSAGES[stage] || stage;

try {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
} catch {}

let data = { stage, message, updatedAt: new Date().toISOString() };
try {
  const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  data.done = prev.done ?? 0;
  data.total = prev.total ?? 0;
  data.current = prev.current ?? '';
} catch {}
try {
  fs.writeFileSync(FILE, JSON.stringify(data));
} catch (e) {
  console.error(`[build-progress] write failed: ${e.message}`);
}
console.log(`[build-progress] ${stage}${message ? ' — ' + message : ''}`);
