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
    takePendingSettings: () => invoke('pending_settings'),
    getPetPreferences: () => invoke('pet_get'),
    setPetPreferences: changes => invoke('pet_set', {changes}),
    onPetPreferences: callback => subscribe('desktop-pet:preferences', callback),
    openPetDirectory: () => invoke('pet_directory'),
    getStartupSettings: () => invoke('startup_get'),
    setStartupSettings: changes => invoke('startup_set', changes),
    onStartupSettings: callback => subscribe('app:startup-settings', callback),
    copyImageToClipboard: dataUrl => invoke('clipboard_copy_image', { dataUrl }),
    platform: navigator.platform.includes('Mac') ? 'darwin' : navigator.platform.includes('Win') ? 'win32' : 'linux',
    startDragging: () => action('drag'),
    isMaximized: () => window.__TAURI__.window.getCurrentWindow().isMaximized(),
    onMaximized: callback => {
      const refresh = () => window.__TAURI__.window.getCurrentWindow().isMaximized().then(callback).catch(() => {});
      refresh();
      return subscribe('tauri://resize', refresh);
    },
    acknowledgeUpdateCompleted: () => invoke('update_ack_completed'),
    getUpdateStatus: () => invoke('update_status'),
    checkForUpdates: () => invoke('update_check'),
    installUpdate: () => invoke('update_install'),
    onUpdateStatus: callback => subscribe('app:update-state', callback),
    getRuntimeStatus: () => invoke('runtime_status'),
    retryRuntime: () => invoke('runtime_retry'),
    getRuntimeNotice: () => invoke('runtime_notice'),
    acknowledgeRuntimeNotice: id => invoke('runtime_ack_notice', { id }),
    onRuntimeStatus: callback => subscribe('tud:runtime-status', callback),
    onRuntimeNotice: callback => subscribe('app:runtime-notice', callback),
    onShellError: callback => subscribe('app:shell-error', callback),
    resizeTrayPopover: height => invoke('tray_resize', { height }),
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
  subscribe('app:popover-shown', () => window.dispatchEvent(new Event('focus')));
  subscribe('tud:data-synced', () => window.dispatchEvent(new CustomEvent('tud:data-synced')));
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
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && new URLSearchParams(location.search).get('view') === 'tray-popover') void action('hide-popover');
  });
  if (location.pathname === '/index.html') history.replaceState(null, '', '/dashboard' + location.search);
})();
