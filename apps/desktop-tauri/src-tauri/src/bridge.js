// The bundled dashboard keeps its existing fetch/API implementation. Only
// local contract requests cross IPC; public pricing and cloud URLs use fetch.
(() => {
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), location.href), init);
    const url = new URL(request.url);
    if (url.origin !== location.origin || !(url.pathname === '/health' || url.pathname.startsWith('/functions/tud-'))) {
      return originalFetch(input, init);
    }
    const response = await invoke('api_request', { request: {
      path: url.pathname + url.search,
      method: request.method,
      body: ['GET', 'HEAD'].includes(request.method) ? null : await request.text(),
    } });
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
  window.tud = {
    openExternal: async (href) => {
      try { await invoke('open_external', { href }); return { ok: true }; }
      catch (error) { return { ok: false, message: String(error) }; }
    },
  };
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (anchor && /^https?:/.test(anchor.href) && new URL(anchor.href).origin !== location.origin) {
      event.preventDefault();
      void window.tud.openExternal(anchor.href);
    }
  });
  if (location.pathname === '/index.html') history.replaceState(null, '', '/dashboard');
})();
