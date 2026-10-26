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
  const subscribe = (event, callback) => {
    let disposed = false;
    let unlisten;
    window.__TAURI__.event.listen(event, message => { if (!disposed) callback(message.payload); })
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  };
  const action = action => invoke('window_action', { action });
  window.tud = {
    runtime: 'tauri',
    minimize: () => action('minimize'),
    toggleMaximize: () => action('maximize'),
    close: () => action('hide'),
    showMainWindow: () => action('show'),
    quit: () => action('quit'),
    setThemeMode: mode => invoke('theme_set', { mode }),
    onJuejinLinkResult: callback => subscribe('app:juejin-link-result', callback),
    openExternal: async (href) => {
      try { await invoke('open_external', { href }); return { ok: true }; }
      catch (error) { return { ok: false, message: String(error) }; }
    },
  };
  subscribe('app:open-settings', detail => window.dispatchEvent(new CustomEvent('tud:open-settings', { detail })));
  subscribe('app:sync-result', result => {
    window.dispatchEvent(new CustomEvent('tud:desktop-sync-result', { detail: result }));
    if (result.ok) window.dispatchEvent(new CustomEvent('tud:data-synced'));
  });
  // Shared dashboard actions use window.open for external documentation/rank.
  // Route those to the OS browser so no popup webview is left unhandled.
  const originalOpen = window.open?.bind(window);
  window.open = (href, ...args) => {
    const url = new URL(String(href), location.href);
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) {
      void window.tud.openExternal(url.href);
      return { opener: null };
    }
    return originalOpen?.(href, ...args) ?? null;
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
