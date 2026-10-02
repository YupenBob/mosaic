import assert from 'node:assert/strict';
import { initLikes } from '../src/assets/js/likes.js';
const previous = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
};
try {
  const values = new Map(),
    classes = new Set();
  const button = {
    dataset: { slug: 'fixture', count: '5' },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    addEventListener: (_name, callback) => (button.click = callback),
  };
  globalThis.document = { querySelector: () => button };
  globalThis.localStorage = globalThis.sessionStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  let finish;
  globalThis.fetch = (url) =>
    url.includes('/like/') ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(Response.json({}));
  const update = initLikes({ apiBase: '/api' });
  update(7);
  assert.ok(button.innerHTML.endsWith('7'));
  const click = button.click();
  assert.ok(classes.has('liked') && button.innerHTML.endsWith('8'), 'click works before stats finish');
  update(100);
  assert.ok(button.innerHTML.endsWith('8'), 'late stats do not overwrite local interaction');
  finish(Response.json({ likes: 8 }));
  await click;
  assert.ok(button.innerHTML.endsWith('8'));
  console.log('Likes: immediate interaction and late statistics protection passed');
} finally {
  Object.assign(globalThis, previous);
}
