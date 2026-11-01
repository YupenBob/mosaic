/**
 * Taxonomy + frontmatter schema smoke test (pure Node, offline).
 *
 * Covers the shared modules that gate every site build and Worker write:
 * route slugs must stay byte-compatible with published URLs while unsafe
 * names (path traversal, control characters, backslashes, overlong) are
 * rejected, and frontmatter errors are hard failures.
 *
 * Run: node tests/taxonomy-smoke.mjs
 */
import assert from 'node:assert/strict';
import {
  MAX_CATEGORY_PATH_LENGTH,
  MAX_TAXONOMY_NAME_LENGTH,
  TaxonomyError,
  assertTaxonomyName,
  categoryRoute,
  categorySegments,
  isValidTaxonomyName,
  tagSlug,
  taxonomyPartSlug,
} from '../shared/taxonomy.mjs';
import {
  ContentSchemaError,
  assertValidFrontmatter,
  frontmatterErrors,
  validateFrontmatter,
} from '../shared/content-schema.mjs';

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  PASS ${name}`);
};

// ── Slugs keep the historical output ──
check('taxonomyPartSlug matches the historical inline slug', () => {
  assert.equal(taxonomyPartSlug('Tech Web'), 'tech-web');
  assert.equal(taxonomyPartSlug('  Tech   Web  '), '-tech-web-');
  assert.equal(taxonomyPartSlug('摄影'), '摄影');
  assert.equal(taxonomyPartSlug('C++'), 'c++');
  assert.equal(taxonomyPartSlug(''), '');
});

check('categoryRoute keeps existing nested routes and trims levels', () => {
  assert.equal(categoryRoute('parent/child/grandchild'), 'parent/child/grandchild');
  assert.equal(categoryRoute('摄影'), '摄影');
  assert.equal(categoryRoute('Tech / Web'), 'tech/web');
  assert.equal(categoryRoute('  Tech  /  Web  '), 'tech/web');
  assert.equal(categoryRoute('A B/C-D'), 'a-b/c-d');
});

check('categorySegments exposes human-readable levels', () => {
  assert.deepEqual(categorySegments('Tech / Web'), ['Tech', 'Web']);
  assert.deepEqual(categorySegments('parent/child'), ['parent', 'child']);
});

check('tagSlug keeps the historical output', () => {
  assert.equal(tagSlug('GIF 动图'), 'gif-动图');
  assert.equal(tagSlug('竖幅'), '竖幅');
  assert.equal(tagSlug('C++'), 'c++');
});

// ── Names that must stay accepted (only the new unsafe cases are rejected) ──
check('previously valid taxonomy names are still accepted', () => {
  for (const name of ['parent/child/grandchild', 'Tech / Web', '摄影', '竖幅', 'a-b_c', 'A B', 'C++', 'C#', '--x--'])
    assert.equal(assertTaxonomyName(name, { kind: 'category' }), name);
  for (const tag of ['竖幅', '构图', 'GIF 动图', 'C++', 'C#', 'a-b_c', 'A B', '--x--'])
    assert.equal(assertTaxonomyName(tag, { kind: 'tag' }), tag);
  assert.equal(isValidTaxonomyName('摄影'), true);
  assert.equal(isValidTaxonomyName('a/b', { kind: 'tag' }), false);
});

// ── Unsafe names: hard rejection ──
check('".." and "." are rejected for tags and categories', () => {
  for (const bad of ['..', '.', ' .. ', 'a/../b', 'a/./b']) {
    assert.throws(() => assertTaxonomyName(bad, { kind: 'category' }), TaxonomyError, bad);
  }
  for (const bad of ['..', '.', ' .. '])
    assert.throws(() => assertTaxonomyName(bad, { kind: 'tag' }), TaxonomyError, bad);
});

check('empty segments / empty names are rejected for categories', () => {
  for (const bad of ['', 'a//b', '/a', 'a/', 'a/ /b', '   '])
    assert.throws(() => assertTaxonomyName(bad, { kind: 'category' }), TaxonomyError, JSON.stringify(bad));
  assert.throws(() => assertTaxonomyName('', { kind: 'tag' }), TaxonomyError);
});

check('control characters and backslashes are rejected', () => {
  for (const bad of ['a\u0000b', 'a\u001fb', 'a\u007fb', 'a\\b'])
    assert.throws(() => assertTaxonomyName(bad), TaxonomyError, JSON.stringify(bad));
  assert.throws(() => assertTaxonomyName('a\\b/c', { kind: 'category' }), TaxonomyError);
});

check('tags cannot smuggle path separators', () => {
  for (const bad of ['a/b', '../a', 'a/../../index', '/absolute'])
    assert.throws(() => assertTaxonomyName(bad, { kind: 'tag' }), TaxonomyError, bad);
});

check('overlong names are rejected', () => {
  assert.equal(assertTaxonomyName('x'.repeat(MAX_TAXONOMY_NAME_LENGTH)), 'x'.repeat(MAX_TAXONOMY_NAME_LENGTH));
  assert.throws(() => assertTaxonomyName('x'.repeat(MAX_TAXONOMY_NAME_LENGTH + 1)), TaxonomyError);
  const longCategory = Array(3).fill('x'.repeat(MAX_TAXONOMY_NAME_LENGTH)).join('/');
  assert.ok(longCategory.length > MAX_CATEGORY_PATH_LENGTH);
  assert.throws(() => assertTaxonomyName(longCategory, { kind: 'category' }), TaxonomyError);
});

check('non-string names are rejected', () => {
  for (const bad of [undefined, null, 42, {}, []]) assert.throws(() => assertTaxonomyName(bad), TaxonomyError);
});

// ── Frontmatter schema ──
check('valid frontmatter passes without errors or warnings', () => {
  const result = validateFrontmatter(
    {
      title: 'Portrait 019370',
      date: '2026-04-28T00:00:00.000Z',
      category: '摄影/竖幅',
      tags: ['竖幅', '构图'],
      description: 'A photo',
      cover: 'photo:0',
      media: { gallery: ['ast_x'] },
    },
    { slug: 'pt-019370' },
  );
  assert.deepEqual(result, { errors: [], warnings: [] });
});

check('missing optional frontmatter is valid (generator supplies defaults)', () => {
  assert.deepEqual(validateFrontmatter({}).errors, []);
  assert.deepEqual(validateFrontmatter({ title: 'x', category: null, tags: null }).errors, []);
});

check('bad dates and field types are hard errors', () => {
  assert.ok(validateFrontmatter({ date: 'not-a-date' }).errors.some((e) => e.includes('date')));
  assert.ok(validateFrontmatter({ category: 5 }).errors.some((e) => e.includes('category must be a string')));
  assert.ok(validateFrontmatter({ tags: 'x' }).errors.some((e) => e.includes('tags must be an array')));
  assert.ok(validateFrontmatter({ tags: ['ok', 3] }).errors.some((e) => e.includes('tags must be an array')));
  assert.ok(validateFrontmatter({ title: 7 }).errors.some((e) => e.includes('title must be a string')));
  assert.ok(validateFrontmatter({ media: [] }).errors.some((e) => e.includes('media must be an object')));
  assert.ok(validateFrontmatter({ video_mode: 'carousel' }).errors.some((e) => e.includes('video_mode')));
  assert.ok(validateFrontmatter({ views: -1 }).errors.some((e) => e.includes('views')));
});

check('unsafe category/tag names are hard errors (build cannot write outside dist)', () => {
  const tagResult = validateFrontmatter({ tags: ['..'] });
  assert.equal(tagResult.errors.length, 1);
  assert.match(tagResult.errors[0], /tag "\.\."/);
  assert.ok(validateFrontmatter({ category: 'a/../b' }).errors.some((e) => e.includes('category')));
  assert.ok(validateFrontmatter({ category: 'a//b' }).errors.some((e) => e.includes('empty path segments')));
  assert.ok(validateFrontmatter({ tags: ['a/../../index'] }).errors.some((e) => e.includes('"/"')));
  assert.deepEqual(
    frontmatterErrors({ tags: ['..'] }),
    validateFrontmatter({ tags: ['..'] }).errors,
    'frontmatterErrors is a convenience view on the same rules',
  );
});

check('invalid post directory names are hard errors when slug is supplied', () => {
  assert.ok(validateFrontmatter({}, { slug: '..' }).errors.length > 0);
  assert.ok(validateFrontmatter({}, { slug: 'a/b' }).errors.length > 0);
  assert.deepEqual(validateFrontmatter({}, { slug: 'pt-019370' }).errors, []);
});

check('cosmetic issues stay warnings (historical leniency)', () => {
  const blocks = validateFrontmatter({ blocks: ['text', 'unknown-block'] });
  assert.deepEqual(blocks.errors, []);
  assert.equal(blocks.warnings.length, 1);
  assert.match(blocks.warnings[0], /blocks must be/);
  const dupes = validateFrontmatter({ tags: ['a', 'a'] });
  assert.deepEqual(dupes.errors, []);
  assert.match(dupes.warnings[0], /duplicates/);
});

check('assertValidFrontmatter throws ContentSchemaError with every error', () => {
  assert.throws(
    () => assertValidFrontmatter({ date: 'nope', tags: ['..'] }, { slug: 'evil' }),
    (error) => error instanceof ContentSchemaError && error.errors.length === 2 && /evil/.test(error.message),
  );
  const valid = { title: 'ok' };
  assert.equal(assertValidFrontmatter(valid), valid);
});

console.log(`\nTaxonomy smoke: ${checks} checks passed`);
