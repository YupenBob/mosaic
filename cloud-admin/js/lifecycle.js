/** A page owns its requests, listeners and timers until the router disposes it. */
export function createPageScope() {
  const controller = new AbortController();
  const cleanups = new Set();
  return {
    signal: controller.signal,
    own(cleanup) {
      cleanups.add(cleanup);
      return cleanup;
    },
    dispose() {
      controller.abort();
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    },
  };
}
export function pageTimeout(callback, delay, signal) {
  if (signal?.aborted) return null;
  const cancel = () => clearTimeout(timer);
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', cancel);
    if (!signal?.aborted) callback();
  }, delay);
  signal?.addEventListener('abort', cancel, { once: true });
  return timer;
}
