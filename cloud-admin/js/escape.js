/**
 * Context-aware escaping helpers.
 *
 * HTML escaping alone is not enough when a value is interpolated into an inline
 * event handler: the HTML parser decodes entities before JavaScript runs, so a
 * single quote in a filename can break out of the string literal. `jsStr`
 * produces a complete, double-quoted JavaScript string literal, then escapes
 * the HTML attribute delimiters around it.
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

/**
 * Serialize a value as a JavaScript string literal that is safe inside an HTML
 * attribute. Use it without surrounding quotes:
 *
 *   `<button onclick="remove(${jsStr(name)})">`
 *
 * @param {unknown} value
 * @returns {string}
 */
export function jsStr(value) {
  const json = JSON.stringify(value === null || value === undefined ? '' : String(value))
    // U+2028/U+2029 are valid in JSON but were line terminators in older JS.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return escapeAttribute(json);
}
