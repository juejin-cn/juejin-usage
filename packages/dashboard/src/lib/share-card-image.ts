import jetBrainsMonoDataUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url&inline';
import { toBlob } from 'html-to-image';

const PNG_MIME_TYPE = 'image/png';
const TRANSPARENT_IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+XqY5WQAAAABJRU5ErkJggg==';
export const SHARE_CARD_DESIGN_WIDTH = 300;
export const SHARE_CARD_DESIGN_HEIGHT = 450;
export const SHARE_CARD_EXPORT_WIDTH = 1365;
export const SHARE_CARD_EXPORT_HEIGHT = 2048;
export const SHARE_CARD_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';
export const SHARE_CARD_MONO_FONT_FAMILY =
  '"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SHARE_CARD_FONT_EMBED_CSS = `
  @font-face {
    font-family: "JetBrains Mono Variable";
    src: url("${jetBrainsMonoDataUrl}") format("woff2");
    font-style: normal;
    font-weight: 100 800;
  }
`;

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

async function waitForShareImageAssets(node: HTMLElement): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(node.querySelectorAll('img')).map((image) => (
      image.decode().catch(() => undefined)
    )),
  );
  await nextPaint();
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取分享资源失败'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

export async function renderShareCardPng(node: HTMLElement): Promise<Blob> {
  await waitForShareImageAssets(node);

  const blob = await toBlob(node, {
    cacheBust: true,
    canvasHeight: SHARE_CARD_EXPORT_HEIGHT,
    canvasWidth: SHARE_CARD_EXPORT_WIDTH,
    fontEmbedCSS: SHARE_CARD_FONT_EMBED_CSS,
    height: SHARE_CARD_DESIGN_HEIGHT,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio: 1,
    width: SHARE_CARD_DESIGN_WIDTH,
  });

  if (!blob) throw new Error('生成分享图片失败');
  return blob;
}

/** Renders a visible share poster at its current preview dimensions. */
export async function renderSharePosterPng(node: HTMLElement): Promise<Blob> {
  await waitForShareImageAssets(node);

  const blob = await toBlob(node, {
    cacheBust: true,
    fontEmbedCSS: SHARE_CARD_FONT_EMBED_CSS,
    imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
    pixelRatio: 3,
  });

  if (!blob) throw new Error('生成分享图片失败');
  return blob;
}

export function downloadShareCardPng(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download = `juejin-ai-usage-${new Date().toISOString().slice(0, 10)}.png`;
  anchor.href = url;
  anchor.click();
  window.requestAnimationFrame(() => URL.revokeObjectURL(url));
}

export async function copyShareCardPng(blob: Promise<Blob>): Promise<void> {
  const desktopBridge = (window as unknown as {
    tud?: { copyImageToClipboard?: (dataUrl: string) => Promise<boolean> };
  }).tud;

  if (desktopBridge?.copyImageToClipboard) {
    const copied = await desktopBridge.copyImageToClipboard(
      await blobToDataUrl(await blob),
    );
    if (!copied) throw new Error('复制图片到系统剪贴板失败');
    return;
  }

  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('当前环境不支持复制图片到剪贴板');
  }

  await navigator.clipboard.write([
    new ClipboardItem({ [PNG_MIME_TYPE]: blob }),
  ]);
}
