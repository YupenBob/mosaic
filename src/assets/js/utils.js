/**
 * Utility helpers for Poh
 */
export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

export function formatNumber(n) {
  if (n == null) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

export function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function highlightTerm(text, query) {
  if (!query || !text) return escapeHTML(text || '');
  const escaped = escapeHTML(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(`(${q})`, 'gi'), '<mark class="search-highlight">$1</mark>');
}

export function $(selector, parent) {
  return (parent || document).querySelector(selector);
}

export function $$(selector, parent) {
  return Array.from((parent || document).querySelectorAll(selector));
}
