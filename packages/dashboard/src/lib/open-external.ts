type DesktopOpenExternal = (url: string) => Promise<{ ok: boolean; message?: string }>;

/** Open web links outside the desktop shell while preserving browser behavior. */
export function openExternalUrl(url: string): void {
  const desktopOpen = (
    window as { tud?: { openExternal?: DesktopOpenExternal } }
  ).tud?.openExternal;

  if (typeof desktopOpen === 'function') {
    void desktopOpen(url);
    return;
  }

  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
    return;
  }
  window.location.assign(url);
}
