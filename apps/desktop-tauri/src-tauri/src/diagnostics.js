// Runs before application modules, including when a module fails to load.
(() => {
  const report = (kind, path = location.pathname, errorType = '') => {
    void window.__TAURI__.core.invoke('frontend_diagnostic', {
      kind, path, errorType,
    }).catch(() => {});
  };
  report('bridge-ready');
  window.addEventListener('error', event => {
    if (event.target !== window) {
      const resource = event.target?.src || event.target?.href;
      report('resource-error', resource ? new URL(resource, location.href).pathname : location.pathname);
    } else {
      report('script-error', location.pathname, event.error?.name || 'Error');
    }
  }, true);
  window.addEventListener('unhandledrejection', event => {
    report('unhandled-rejection', location.pathname, event.reason?.name || 'Error');
  });
  document.addEventListener('DOMContentLoaded', () => {
    report('dom-ready');
    const root = document.getElementById('root');
    if (!root) return; // The pet is a separate, non-React surface.
    const mounted = () => root.childElementCount > 0;
    if (mounted()) { report('app-mounted'); return; }
    const observer = new MutationObserver(() => {
      if (mounted()) { observer.disconnect(); report('app-mounted'); }
    });
    observer.observe(root, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      if (!mounted()) report('mount-timeout');
    }, 20_000);
  }, { once: true });
})();
