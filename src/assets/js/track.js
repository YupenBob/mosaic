/**
 * View tracking — sends page view to Worker API
 */
export function initTracking(config) {
  const apiBase = config?.apiBase;
  if (!apiBase) return;

  const body = document.body;
  const slug = body.dataset.slug;
  if (!slug) return;

  const category = body.dataset.category || '';
  const tags = body.dataset.tags ? body.dataset.tags.split(',') : [];

  try {
    fetch(`${apiBase}/track/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, category, tags }),
    }).catch(() => {});
  } catch {}
}
