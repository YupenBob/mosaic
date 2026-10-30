/** Write a fetched cloud draft into the content tree for a preview build. */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const file = process.argv[2];
if (!file) throw new Error('Usage: node write-draft.mjs <draft.json>');
const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const draft = payload.draft || payload;
const slug = String(draft.slug || 'preview-draft').trim();
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) throw new Error('Unsafe preview slug');
const directory = path.join(process.cwd(), 'content/posts', slug);
fs.mkdirSync(directory, { recursive: true });
const frontMatter = { ...(draft.frontMatter || {}) };
if (draft.media) frontMatter.media = draft.media;
if (frontMatter.cover === undefined && draft.media?.cover) frontMatter.cover = draft.media.cover;
fs.writeFileSync(path.join(directory, 'index.md'), matter.stringify(draft.body || '', frontMatter));
console.log(`Preview draft written: ${slug}`);
