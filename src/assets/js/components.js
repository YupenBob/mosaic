/**
 * Frontend Component Loader — dynamically loads and initializes components
 * based on config. Components register via { name, enabled, init(container, config) }
 */
const _registry = [];

export function register(component) {
  _registry.push(component);
}

export async function loadComponents(config, pageType) {
  const components = _registry.filter((c) => c.enabled !== false);
  await Promise.all(
    components.map(async (comp) => {
      if (comp.page !== pageType && comp.page !== 'all') return;
      const compConfig = (config && config[comp.name]) || {};
      if (compConfig.enabled === false) return;
      try {
        await comp.init(document.body, compConfig);
      } catch (err) {
        console.error('Component ' + comp.name + ' init failed:', err);
      }
    }),
  );
}
