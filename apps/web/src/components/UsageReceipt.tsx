import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconBrandJuejin, IconCheck, IconCopy, IconDownload, IconPrinter } from '@tabler/icons-react';
import { useShareSnapshot } from '@/hooks/ShareSnapshotContext';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { ProviderSvgIcon } from '@/components/ProviderIcon';
import { StyledShareQrCode } from '@/components/ShareCardCarousel';
import { formatTokens } from '@/lib/format';
import { blobToDataUrl, copyShareCardPng, downloadShareCardPng } from '@/lib/share-card-image';
import ioskeleyRegularUrl from '../assets/fonts/IoskeleyMono-Regular.woff2?url&inline';
import ioskeleyMediumUrl from '../assets/fonts/IoskeleyMono-Medium.woff2?url&inline';
import ioskeleyBoldUrl from '../assets/fonts/IoskeleyMono-Bold.woff2?url&inline';
import { cn } from '@web/lib/utils';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
  getReceiptTheme,
  hexToRgb01,
  isReceiptThemeId,
  RECEIPT_THEMES,
  type ReceiptTheme,
  type ReceiptThemeId,
} from './receipt-themes';

const RECEIPT_WIDTH = 400;
const EXPORT_SCALE = 3;

const RECEIPT_FONT = '"Ioskeley Mono", Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF_FONT = 'Georgia, "Times New Roman", "New York", serif';

/** Exact SignPainter-HouseScript vector outline for "Juejin Usage" (129.27 x 32.48). */
const SIGNPAINTER_SIGNATURE_PATH =
  'M2.3 12.7C1.5 12.8 0.6 13.7 0.2 15.1C-0.5 17.9 0.8 20.1 3.2 20.5C5.8 20.9 8.5 20.2 11.0 16.1C12.7 13.2 15.8 6.8 16.9 4.3C17.7 2.4 17.5 1.0 17.1 0.3C16.9 -0.1 16.6 -0.1 16.3 0.3C15.3 1.8 12.6 7.3 10.8 10.9C8.7 15.3 6.3 20.2 3.5 19.5C2.5 19.3 1.2 17.8 2.8 13.3C3.0 12.8 2.8 12.6 2.3 12.7Z'
  + 'M20.0 17.4C19.7 19.2 20.6 20.6 22.6 20.6C24.5 20.6 26.5 18.9 27.4 17.1C27.9 16.2 27.8 15.4 27.7 15.1C27.6 14.8 27.3 14.9 27.1 15.2C25.9 17.4 24.3 19.5 22.9 19.6C21.8 19.6 21.6 18.3 22.5 16.5C23.2 14.8 24.8 12.4 25.5 11.0C26.3 9.4 26.0 8.0 25.5 7.4C25.3 7.1 25.1 7.2 24.7 7.6C23.7 9.0 22.8 11.2 20.8 14.4C19.0 17.2 17.3 19.5 16.0 19.4C15.3 19.3 15.2 18.2 15.9 16.6C16.6 15.1 17.2 13.8 18.4 11.9C19.5 10.1 19.7 8.6 19.0 7.6C18.7 7.3 18.4 7.2 18.2 7.6C16.1 10.5 14.4 13.6 13.7 15.8C13.0 17.9 13.1 20.2 15.4 20.4C17.2 20.5 18.9 18.9 20.0 17.4Z'
  + 'M29.6 14.5C31.8 16.3 34.0 15.5 35.5 13.6C36.9 12.0 37.1 10.0 36.6 9.2C36.0 8.5 35.5 8.0 34.7 7.6C33.1 6.6 29.8 8.3 27.7 12.4C25.6 16.6 27.0 20.6 31.1 20.5C33.6 20.5 36.0 19.0 37.4 17.0C38.0 16.2 38.1 15.3 37.9 15.1C37.8 14.8 37.5 14.8 37.4 15.0C36.0 17.1 33.7 19.7 31.0 19.6C29.3 19.5 28.6 17.5 29.6 14.5Z'
  + 'M29.9 13.8C29.9 13.6 30.0 13.5 30.1 13.3C31.6 10.2 34.3 8.3 35.0 8.8C35.4 9.2 34.7 10.9 33.7 12.2C32.7 13.4 31.4 14.8 29.9 13.8Z'
  + 'M44.2 5.2C43.8 4.3 42.9 4.0 42.4 4.5C41.9 5.1 41.8 6.0 42.2 6.8C42.7 7.7 43.6 7.8 44.0 7.3C44.4 6.9 44.6 6.1 44.2 5.2Z'
  + 'M37.2 20.6C38.6 17.4 40.9 13.0 41.7 11.2C42.4 9.6 42.2 8.3 41.8 7.7C41.5 7.4 41.3 7.5 41.0 7.9C39.3 10.5 36.4 16.5 34.2 21.7C31.1 22.9 28.3 24.8 27.3 27.8C26.7 29.6 27.4 30.8 28.0 31.7C28.6 32.6 29.3 32.6 29.9 32.3C32.4 31.4 34.8 26.2 36.6 21.9C39.5 20.7 42.0 19.2 43.2 17.0C43.7 16.2 43.8 15.4 43.7 15.1C43.6 14.8 43.4 14.8 43.2 15.1C41.9 17.1 40.1 19.1 37.2 20.6Z'
  + 'M33.7 23.0C31.7 27.7 29.1 31.2 28.7 30.6C28.1 29.8 29.5 25.4 33.7 23.0Z'
  + 'M50.0 5.3C49.6 4.4 48.6 4.0 48.1 4.6C47.6 5.1 47.5 6.1 48.0 7.0C48.5 7.8 49.4 7.9 49.8 7.4C50.2 7.0 50.4 6.1 50.0 5.3Z'
  + 'M44.8 20.5C46.6 20.5 48.6 19.1 49.5 17.1C49.9 16.3 50.0 15.7 49.8 15.2C49.6 14.9 49.4 14.9 49.3 15.2C48.3 17.4 46.5 19.5 45.1 19.5C44.1 19.6 44.0 18.4 44.8 16.5C45.4 14.9 46.8 12.7 47.5 11.3C48.2 9.7 48.0 8.3 47.5 7.8C47.2 7.5 47.0 7.6 46.7 8.0C45.5 9.7 43.4 13.5 42.6 15.8C41.7 18.4 42.3 20.5 44.8 20.5Z'
  + 'M54.1 10.6C54.5 9.4 54.5 8.3 54.0 7.5C53.8 7.2 53.6 7.2 53.4 7.5C51.3 10.5 48.9 15.0 48.2 17.0C47.7 18.6 47.9 19.6 48.6 20.3C48.8 20.6 49.0 20.4 49.2 20.1C50.5 17.1 51.9 14.1 53.8 12.0C55.9 9.8 57.7 8.9 58.1 9.0C58.6 9.3 55.8 12.7 54.8 15.8C53.8 18.6 54.5 20.6 57.2 20.6C59.0 20.6 61.1 18.9 61.9 17.1C62.4 16.2 62.4 15.5 62.2 15.1C62.1 14.9 61.8 14.9 61.7 15.2C60.5 17.4 58.9 19.5 57.6 19.6C56.4 19.6 56.2 18.1 57.1 16.3C57.8 14.6 59.4 12.2 60.0 10.8C60.8 9.2 59.8 7.6 58.8 7.4C57.7 7.3 55.6 9.0 54.1 10.6Z'
  + 'M70.8 20.4C73.0 21.3 75.8 20.5 78.1 17.3C80.2 14.4 84.2 7.0 85.3 4.5C86.2 2.7 86.1 1.2 85.7 0.6C85.5 0.2 85.2 0.1 85.0 0.5C83.2 3.3 79.7 9.6 78.0 13.1C75.7 17.4 73.2 20.2 71.2 19.4C70.3 19.1 70.2 17.9 70.6 16.2C71.4 12.8 74.6 8.1 76.2 5.0C77.4 2.6 77.3 1.4 76.8 0.6C76.6 0.2 76.3 0.2 76.0 0.6C73.1 5.0 69.5 11.0 68.6 14.6C67.7 18.1 69.2 19.7 70.8 20.4Z'
  + 'M83.7 14.7C83.6 14.5 83.6 14.2 83.6 14.0C83.6 13.5 83.3 13.3 82.9 13.6C81.8 14.5 81.7 16.7 82.5 18.1C83.6 20.1 85.4 20.6 87.2 20.5C89.5 20.4 91.7 19.2 92.9 17.0C93.4 16.0 93.5 15.2 93.4 14.9C93.2 14.6 92.9 14.5 92.7 14.9C91.9 16.6 90.6 18.5 88.5 19.3C89.6 18.5 89.8 17.2 89.9 16.0C90.0 13.7 89.4 11.2 89.6 8.3C89.7 8.1 89.8 7.9 90.0 7.7C90.4 7.0 90.5 6.6 90.2 6.3C89.9 6.0 89.2 6.1 88.5 6.8C87.8 7.4 87.5 8.0 87.3 9.2C86.4 10.9 85.0 12.9 83.7 14.7Z'
  + 'M87.3 11.3C87.4 13.8 87.9 18.9 86.4 19.3C85.4 19.6 84.4 18.3 83.9 16.5C85.2 14.7 86.3 13.0 87.3 11.3Z'
  + 'M102.4 9.6C102.5 8.3 101.9 7.3 100.5 7.3C98.9 7.3 96.4 8.7 93.8 12.5C91.1 16.4 91.7 20.4 94.7 20.4C96.2 20.4 97.7 19.2 98.7 17.9C98.7 19.4 99.6 20.5 101.3 20.6C103.1 20.7 105.1 18.9 105.9 17.1C106.3 16.2 106.3 15.4 106.2 15.2C106.1 14.9 105.9 14.9 105.7 15.2C104.6 17.4 102.8 19.6 101.5 19.6C100.4 19.7 100.5 18.3 101.3 16.5C102.0 14.8 103.6 12.4 104.3 11.0C105.1 9.4 104.8 8.0 104.4 7.4C104.1 7.2 103.9 7.2 103.6 7.6C103.2 8.1 102.9 8.8 102.4 9.6Z'
  + 'M99.7 14.5C98.0 17.4 96.4 19.4 95.0 19.4C93.8 19.3 94.2 16.5 95.9 13.8C97.7 10.9 100.0 8.8 101.0 8.9C102.0 9.0 101.7 11.0 99.7 14.5Z'
  + 'M118.4 17.1C118.9 16.2 119.1 15.5 119.0 15.2C119.0 14.9 118.7 14.9 118.5 15.2C117.2 16.9 115.4 18.6 112.7 20.0C114.1 16.9 116.1 13.0 117.1 11.1C117.9 9.5 117.6 8.1 117.1 7.6C116.9 7.3 116.6 7.3 116.3 7.8C116.0 8.3 115.7 8.9 115.3 9.5C115.3 8.4 114.7 7.4 113.4 7.4C111.8 7.4 109.2 8.8 106.7 12.6C104.1 16.4 104.6 20.4 107.6 20.4C108.8 20.4 109.9 19.7 110.8 18.8C110.5 19.5 110.2 20.3 109.9 21.0C106.7 22.2 104.0 24.2 103.0 27.1C102.4 28.9 103.0 30.1 103.7 31.0C104.3 31.9 104.9 32.0 105.5 31.7C108.1 30.7 110.4 25.6 112.2 21.3C114.8 20.3 117.1 19.1 118.4 17.1Z'
  + 'M112.5 14.6C110.9 17.4 109.2 19.4 108.0 19.4C106.7 19.4 107.0 16.6 108.8 13.8C110.5 11.0 112.9 9.0 113.9 9.0C114.8 9.1 114.5 11.1 112.5 14.6Z'
  + 'M109.4 22.3C107.3 27.2 104.7 30.5 104.3 29.9C103.8 29.1 105.2 24.8 109.4 22.3Z'
  + 'M120.9 14.5C123.1 16.3 125.3 15.5 126.8 13.6C128.2 12.0 128.4 10.0 127.8 9.2C127.3 8.5 126.8 8.0 126.0 7.6C124.4 6.6 121.1 8.3 119.0 12.4C116.9 16.6 118.3 20.6 122.4 20.5C124.9 20.5 127.3 19.0 128.7 17.0C129.3 16.2 129.4 15.3 129.2 15.1C129.1 14.8 128.8 14.8 128.7 15.0C127.3 17.1 125.0 19.7 122.3 19.6C120.6 19.5 119.8 17.5 120.9 14.5Z'
  + 'M121.2 13.8C121.2 13.6 121.3 13.5 121.4 13.3C122.9 10.2 125.6 8.3 126.2 8.8C126.7 9.2 126.0 10.9 125.0 12.2C124.0 13.4 122.7 14.8 121.2 13.8Z';

const EMBEDDED_FONT_CSS = `
  @font-face {
    font-family: "Ioskeley Mono";
    src: url("${ioskeleyRegularUrl}") format("woff2");
    font-style: normal;
    font-weight: 400;
    unicode-range: U+0020-007E, U+00A5, U+00B7, U+2014, U+2026, U+2248;
  }
  @font-face {
    font-family: "Ioskeley Mono";
    src: url("${ioskeleyMediumUrl}") format("woff2");
    font-style: normal;
    font-weight: 500;
    unicode-range: U+0020-007E, U+00A5, U+00B7, U+2014, U+2026, U+2248;
  }
  @font-face {
    font-family: "Ioskeley Mono";
    src: url("${ioskeleyBoldUrl}") format("woff2");
    font-style: normal;
    font-weight: 600 700;
    unicode-range: U+0020-007E, U+00A5, U+00B7, U+2014, U+2026, U+2248;
  }
`;

async function inlineSvgImages(artwork: SVGSVGElement) {
  const images = Array.from(artwork.querySelectorAll<SVGImageElement>('image'));
  await Promise.all(images.map(async img => {
    const href = img.getAttribute('href') || img.getAttribute('xlink:href') || '';
    if (!href || href.startsWith('data:')) return;
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error('图片加载失败');
      img.setAttribute('href', await blobToDataUrl(await response.blob()));
      img.removeAttribute('xlink:href');
    } catch {
      img.remove();
    }
  }));
}

async function renderReceiptPng(svg: SVGSVGElement) {
  // Standalone SVG omits the page stylesheet, so embed Ioskeley Mono & finish print state.
  const artwork = svg.cloneNode(true) as SVGSVGElement;
  artwork.removeAttribute('class');
  artwork.style.background = 'transparent';
  artwork.querySelectorAll('.usage-receipt-paper, .usage-receipt-led-printing').forEach(node => {
    node.removeAttribute('class');
  });
  const statusEl = artwork.querySelector<SVGTextElement>('[data-printer-status]');
  if (statusEl) statusEl.textContent = 'Printer';
  const defs = artwork.querySelector('defs') ?? artwork.insertBefore(
    document.createElementNS('http://www.w3.org/2000/svg', 'defs'),
    artwork.firstChild,
  );
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = EMBEDDED_FONT_CSS;
  defs.appendChild(styleEl);

  await inlineSvgImages(artwork);

  const width = svg.viewBox.baseVal.width || RECEIPT_WIDTH;
  const height = svg.viewBox.baseVal.height;
  // Scale intrinsic SVG dimensions before rasterizing so browsers render at 3x directly.
  artwork.setAttribute('width', String(width * EXPORT_SCALE));
  artwork.setAttribute('height', String(height * EXPORT_SCALE));

  const source = new XMLSerializer().serializeToString(artwork);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * EXPORT_SCALE;
    canvas.height = height * EXPORT_SCALE;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('无法生成小票');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法导出图片')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const illustrativeCnyPerUsd = 7;

function charUnits(char: string) {
  return char.codePointAt(0)! > 127 ? 2 : 1;
}

function truncateText(text: string, maxUnits: number) {
  let out = '';
  let width = 0;
  for (const char of text) {
    const units = charUnits(char);
    if (width + units > maxUnits) return `${out.trimEnd()}…`;
    out += char;
    width += units;
  }
  return out;
}

function formatReceiptTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function ReceiptTextureDefs({ id, theme }: { id: string; theme: ReceiptTheme }) {
  if (theme.texture === 'paper') {
    return (
      <pattern id={`${id}-texture`} width="64" height="64" patternUnits="userSpaceOnUse">
        <circle cx="9" cy="13" r="0.8" fill="#8b7355" opacity="0.12" />
        <circle cx="37" cy="7" r="0.6" fill="#6f5a42" opacity="0.1" />
        <circle cx="52" cy="24" r="0.9" fill="#a89070" opacity="0.11" />
        <circle cx="21" cy="39" r="0.7" fill="#7d674c" opacity="0.1" />
        <circle cx="46" cy="53" r="0.8" fill="#6f5a42" opacity="0.12" />
        <circle cx="11" cy="57" r="0.6" fill="#9c8669" opacity="0.1" />
        <path d="M4 26c4-1 8 1 11 0M32 45c5 1 9-1 13 0M44 14c3 1 6 0 8-1" stroke="#8a7459" strokeWidth="0.6" opacity="0.09" fill="none" />
        <path d="M18 11c2 2 5 2 7 1M54 36c-2 2-5 3-7 2" stroke="#ffffff" strokeWidth="0.6" opacity="0.3" fill="none" />
      </pattern>
    );
  }
  if (theme.texture === 'kraft') {
    return (
      <pattern id={`${id}-texture`} width="72" height="72" patternUnits="userSpaceOnUse">
        {/* Organic kraft pulp fibers & warm flecks */}
        <path d="M5 10l9 2M24 6l6-2M47 14l11-3M14 29l12 1M41 31l8 3M60 24l7-2M8 49l10-3M29 53l13 2M54 47l9-2M17 65l8 2M44 64l11-2" stroke="#7c542b" strokeWidth="0.9" strokeLinecap="round" opacity="0.16" />
        <path d="M19 18l7-2M36 22l9 1M6 38l8 2M51 39l8-3M23 44l6-2M39 58l7 1M62 60l6-2" stroke="#f6e6c8" strokeWidth="0.8" strokeLinecap="round" opacity="0.22" />
        <circle cx="12" cy="18" r="1.1" fill="#5e3c1b" opacity="0.14" />
        <circle cx="33" cy="12" r="0.8" fill="#4f3116" opacity="0.15" />
        <circle cx="58" cy="18" r="1" fill="#6e4923" opacity="0.13" />
        <circle cx="26" cy="36" r="1.2" fill="#5b3a1b" opacity="0.12" />
        <circle cx="64" cy="42" r="0.9" fill="#4d2f14" opacity="0.15" />
        <circle cx="15" cy="56" r="1" fill="#6b4724" opacity="0.14" />
        <circle cx="48" cy="68" r="0.8" fill="#4c2e13" opacity="0.14" />
      </pattern>
    );
  }
  if (theme.texture === 'grid') {
    return (
      <pattern id={`${id}-texture`} width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M20 0H0V20" fill="none" stroke="#1f80ff" strokeWidth="0.6" opacity="0.09" />
      </pattern>
    );
  }
  if (theme.texture === 'carbon') {
    return (
      <pattern id={`${id}-texture`} width="16" height="16" patternUnits="userSpaceOnUse">
        <circle cx="4" cy="4" r="0.7" fill="#ffffff" opacity="0.045" />
        <circle cx="12" cy="12" r="0.7" fill="#ffffff" opacity="0.045" />
      </pattern>
    );
  }
  return null;
}

function ThemeSwatchThumbnail({ theme, active }: { theme: ReceiptTheme; active?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-[5px] border"
      style={{
        backgroundColor: theme.swatchBg,
        borderColor: active ? 'var(--primary)' : theme.swatchBorder,
      }}
    >
      {theme.texture === 'grid' && (
        <span
          className="absolute inset-0"
          style={{
            backgroundImage: 'linear-gradient(to right, rgba(31,128,255,0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,128,255,0.14) 1px, transparent 1px)',
            backgroundSize: '6px 6px',
          }}
        />
      )}
      {theme.texture === 'kraft' && (
        <span
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: 'radial-gradient(#5c3818 0.6px, transparent 0.6px)',
            backgroundSize: '5px 5px',
          }}
        />
      )}
      <span className="relative flex flex-col gap-0.5">
        <span className="h-[2px] w-3 rounded-full" style={{ backgroundColor: theme.swatchAccent }} />
        <span className="h-[1.5px] w-2 rounded-full opacity-55" style={{ backgroundColor: theme.swatchAccent }} />
      </span>
    </span>
  );
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function UsageReceipt() {
  const { snapshot } = useShareSnapshot();
  const { userName, avatarLarge } = useJuejinAuth();
  const name = userName?.trim() || '掘金用户';
  const svg = useRef<SVGSVGElement>(null);
  const id = useId();
  const [themeId, setThemeId] = useLocalStorage<ReceiptThemeId>(
    'tud.receiptTheme',
    'classic',
    isReceiptThemeId,
  );
  const [showPrinter, setShowPrinter] = useLocalStorage<boolean>(
    'tud.receiptShowPrinter',
    true,
    isBoolean,
  );
  const theme = getReceiptTheme(themeId);
  const [print, setPrint] = useState(0);
  const [printing, setPrinting] = useState(() => showPrinter && !prefersReducedMotion());
  const [dotCount, setDotCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [doneAction, setDoneAction] = useState<'copy' | 'download' | null>(null);
  const [errorStatus, setErrorStatus] = useState('');
  const printedAt = useMemo(() => formatReceiptTime(new Date()), [print]);

  useEffect(() => {
    if (!printing || !showPrinter) return;
    setDotCount(1);
    const timer = window.setInterval(() => {
      setDotCount(c => (c % 3) + 1);
    }, 340);
    return () => window.clearInterval(timer);
  }, [printing, print, showPrinter]);

  useEffect(() => {
    if (!doneAction) return;
    const timer = window.setTimeout(() => setDoneAction(null), 1800);
    return () => window.clearTimeout(timer);
  }, [doneAction]);

  if (!snapshot) return <p className="p-8 text-center text-sm text-muted">等待用量数据</p>;

  const { summary, rangeLabel, toolLabel } = snapshot;
  const tools = snapshot.tools ?? [];
  const metaText = `${rangeLabel} · ${toolLabel}`;

  // Compact, balanced thermal receipt vertical cadence
  const paperTop = showPrinter ? 70 : 14;
  const signatureTop = paperTop + 20;
  const metaTop = paperTop + 62;
  const tableDividerY = metaTop + 60;
  const tableHeaderY = tableDividerY + 20;
  const rowHeight = 25;
  const items = tools.map((tool, index) => ({
    ...tool,
    displayLabel: truncateText(tool.label, 19),
    y: tableHeaderY + 22 + index * rowHeight,
  }));
  const listBottom = items.length ? items[items.length - 1]!.y + 14 : tableHeaderY + 38;
  const detailTop = listBottom + 4;
  const totalTop = detailTop + 90;
  const footerTop = totalTop + 112;
  const bottom = footerTop + 84;
  const height = bottom + 18;
  const svgViewBoxX = showPrinter ? 0 : 16;
  const svgWidth = showPrinter ? RECEIPT_WIDTH : 368;

  const detailRows = [
    ['输入 Token', formatTokens(summary.inputTokens)],
    ['输出 Token', formatTokens(summary.outputTokens)],
    ['缓存读取', formatTokens(summary.cachedInputTokens)],
    ['缓存写入', formatTokens(summary.cacheCreationInputTokens)],
  ] as const;

  const paperPath = `M32 ${paperTop}H368V${bottom} ${'h-2 a 4 4 0 0 0 -8 0 h-2 '.repeat(28)}Z`;
  const inkFilterId = `${id}-ink`;
  const iconTintFilterId = `${id}-icon-tint`;
  const paperClipId = `${id}-paper-clip`;

  const [inkR, inkG, inkB] = hexToRgb01(theme.inkPrimary);
  const [paperR, paperG, paperB] = hexToRgb01(theme.paperFlat);

  function handleShowPrinterChange(next: boolean) {
    setShowPrinter(next);
    if (next) {
      setPrinting(!prefersReducedMotion());
      setPrint(n => n + 1);
    } else {
      setPrinting(false);
    }
  }

  function replay() {
    if (!showPrinter) return;
    setPrinting(!prefersReducedMotion());
    setPrint(n => n + 1);
  }

  async function save(action: 'copy' | 'download') {
    if (!svg.current || busy) return;
    setBusy(true);
    setErrorStatus('');
    try {
      const png = renderReceiptPng(svg.current);
      if (action === 'copy') await copyShareCardPng(png);
      else downloadShareCardPng(await png);
      setDoneAction(action);
    } catch {
      setErrorStatus(action === 'copy' ? '复制失败，请下载图片' : '下载失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const liveStatus = errorStatus
    || (doneAction === 'copy' ? '小票已复制到剪贴板' : doneAction === 'download' ? '小票图片已保存' : '');

  return (
    <div className="flex max-h-[calc(100svh-2rem)] flex-col overflow-hidden md:flex-row">
      {/* Desktop Left Column: Paper Themes + Bottom Actions (no vertical divider border) */}
      <aside className="hidden w-[276px] shrink-0 flex-col bg-popover p-5 md:flex">
        <h2 className="text-base font-semibold text-foreground">打印小票</h2>

        <div className="mt-5">
          <div className="text-xs font-medium text-muted">纸张风格</div>
          <div
            role="radiogroup"
            aria-label="小票风格"
            className="mt-2.5 grid grid-cols-2 gap-2"
          >
            {RECEIPT_THEMES.map((item) => {
              const active = item.id === theme.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setThemeId(item.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-primary bg-(--web-primary-soft) text-primary'
                      : 'border-border/80 bg-surface text-foreground hover:border-foreground/20 hover:bg-surface-secondary/70',
                  )}
                >
                  <ThemeSwatchThumbnail theme={item} active={active} />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/80 bg-surface px-3 py-2.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-surface-secondary/70">
          <Checkbox
            checked={showPrinter}
            onCheckedChange={(checked) => handleShowPrinterChange(checked === true)}
          />
          <span>展示打印机</span>
        </label>

        {/* Actions pinned at the bottom of the left control column */}
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <Button className="w-full" disabled={busy} onClick={() => void save('download')}>
            {doneAction === 'download' ? <IconCheck aria-hidden="true" /> : <IconDownload aria-hidden="true" />}
            {doneAction === 'download' ? '已保存' : '下载图片'}
          </Button>
          <div className={cn('grid gap-2', showPrinter ? 'grid-cols-2' : 'grid-cols-1')}>
            <Button variant="secondary" disabled={busy} onClick={() => void save('copy')}>
              {doneAction === 'copy' ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
              {doneAction === 'copy' ? '已复制' : '复制'}
            </Button>
            {showPrinter && (
              <Button variant="secondary" onClick={replay}>
                <IconPrinter aria-hidden="true" />
                重播
              </Button>
            )}
          </div>
          {errorStatus && (
            <p className="text-center text-xs text-destructive">{errorStatus}</p>
          )}
        </div>
      </aside>

      {/* Mobile Top Header + Horizontal Theme Strip */}
      <div className="shrink-0 px-4 pt-4 pb-2 md:hidden">
        <div className="flex items-center justify-between gap-2 pr-8">
          <div className="text-base font-semibold text-foreground">打印小票</div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-foreground">
            <Checkbox
              checked={showPrinter}
              onCheckedChange={(checked) => handleShowPrinterChange(checked === true)}
            />
            <span>展示打印机</span>
          </label>
        </div>
        <div
          role="radiogroup"
          aria-label="小票风格"
          className="mt-2.5 -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]"
        >
          {RECEIPT_THEMES.map((item) => {
            const active = item.id === theme.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setThemeId(item.id)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'border-primary bg-(--web-primary-soft) text-primary'
                    : 'border-border bg-surface text-foreground hover:bg-surface-secondary',
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-3.5 rounded-full border"
                  style={{ backgroundColor: item.swatchBg, borderColor: item.swatchAccent }}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Column (Desktop): Pure Receipt Preview Stage */}
      <div className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto bg-surface-secondary/45 px-4 py-4 md:max-h-[min(680px,calc(100svh-2rem))] md:px-6 md:pt-8 md:pb-6 dark:bg-white/[0.025] [scrollbar-width:thin]">
        <svg
          ref={svg}
          xmlns="http://www.w3.org/2000/svg"
          width={svgWidth}
          height={height}
          viewBox={`${svgViewBoxX} 0 ${svgWidth} ${height}`}
          role="img"
          aria-label={`${rangeLabel}用量小票，${toolLabel}，共 ${summary.totalTokens} Token`}
          className="my-auto h-auto w-full max-w-[310px] shrink-0 md:max-w-[356px]"
          fontFamily={RECEIPT_FONT}
        >
          <defs>
            {showPrinter && (
              <>
                <linearGradient id={`${id}-chassis`} x1="0" y1="12" x2="0" y2="84" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor={theme.chassisTop} />
                  <stop offset="100%" stopColor={theme.chassisBottom} />
                </linearGradient>
                <linearGradient id={`${id}-slot`} x1="0" y1="64" x2="0" y2="75" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor={theme.slotTop} />
                  <stop offset="100%" stopColor={theme.slotBottom} />
                </linearGradient>
                <linearGradient id={`${id}-slot-shadow`} x1="0" y1={paperTop} x2="0" y2={paperTop + 18} gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#000000" stopOpacity={theme.slotShadowOpacity} />
                  <stop offset="100%" stopColor="#000000" stopOpacity="0" />
                </linearGradient>
                <filter id={`${id}-chassis-shadow`} x="-8%" y="-16%" width="116%" height="145%">
                  <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor={theme.shadowColor} floodOpacity={theme.shadowOpacity * 1.1} />
                </filter>
                <filter id={`${id}-led-glow`} x="-150%" y="-60%" width="400%" height="220%">
                  <feGaussianBlur stdDeviation="2.5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <clipPath id={`${id}-slot-clip`}>
                  <rect x="16" y={paperTop} width="368" height={height - paperTop} />
                </clipPath>
              </>
            )}
            <linearGradient id={`${id}-paper`} x1="0" y1={paperTop} x2="0" y2={bottom} gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor={theme.paperTop} />
              <stop offset="100%" stopColor={theme.paperBottom} />
            </linearGradient>
            <filter id={`${id}-paper-shadow`} x="-10%" y="-4%" width="120%" height="108%">
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor={theme.shadowColor} floodOpacity={theme.shadowOpacity * 1.2} />
            </filter>
            {/* Convert color-only brand icons into crisp monochrome black/white before tinting */}
            <filter id={inkFilterId} colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0" />
              <feComponentTransfer>
                <feFuncR type="linear" slope="3.4" intercept="-2.05" />
                <feFuncG type="linear" slope="3.4" intercept="-2.05" />
                <feFuncB type="linear" slope="3.4" intercept="-2.05" />
              </feComponentTransfer>
            </filter>
            {/* Map monochrome black (0) -> theme.inkPrimary and white cutout (1) -> theme.paperFlat */}
            <filter id={iconTintFilterId} colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0" />
              <feComponentTransfer>
                <feFuncR type="linear" slope={paperR - inkR} intercept={inkR} />
                <feFuncG type="linear" slope={paperG - inkG} intercept={inkG} />
                <feFuncB type="linear" slope={paperB - inkB} intercept={inkB} />
              </feComponentTransfer>
            </filter>
            <ReceiptTextureDefs id={id} theme={theme} />
            <clipPath id={paperClipId}>
              <path d={paperPath} />
            </clipPath>
            <clipPath id={`${id}-avatar`}>
              <circle cx="71" cy="42" r="19" />
            </clipPath>
            <clipPath id={`${id}-user-info`}>
              <rect x="102" y="16" width="168" height="52" />
            </clipPath>
          </defs>

          {/* Minimalist thermal printer housing (transparent canvas — printer + paper only) */}
          {showPrinter && (
            <g>
              <g filter={`url(#${id}-chassis-shadow)`}>
                <rect
                  x="14"
                  y="12"
                  width="372"
                  height="72"
                  rx="16"
                  fill={`url(#${id}-chassis)`}
                  stroke={theme.chassisStroke}
                  strokeWidth="1"
                />
              </g>
              {/* Recessed display panel */}
              <rect x="22" y="20" width="356" height="36" rx="10" fill={theme.panelFill} stroke={theme.panelStroke} strokeWidth="1" />
              {/* Vertical glowing status LED */}
              <rect
                x="34"
                y="29"
                width="4.5"
                height="18"
                rx="2.25"
                fill={theme.ledColor}
                filter={`url(#${id}-led-glow)`}
                className={printing ? 'usage-receipt-led-printing' : undefined}
              />
              {/* Printer status readout: animated Printing... -> Printer */}
              <text
                data-printer-status=""
                x="362"
                y="43"
                textAnchor="end"
                fontFamily={SERIF_FONT}
                fontSize="13.5"
                fontWeight="600"
                fill={theme.statusText}
              >
                {printing ? (
                  <>
                    <tspan>Printing</tspan>
                    <tspan opacity={dotCount >= 1 ? 1 : 0}>.</tspan>
                    <tspan opacity={dotCount >= 2 ? 1 : 0}>.</tspan>
                    <tspan opacity={dotCount >= 3 ? 1 : 0}>.</tspan>
                  </>
                ) : 'Printer'}
              </text>
              {/* Recessed paper feed slot */}
              <rect x="24" y="64" width="352" height="11" rx="5.5" fill={`url(#${id}-slot)`} />
            </g>
          )}

          {/* Thermal paper feeding step-by-step from the slot (or standalone paper receipt) */}
          <g clipPath={showPrinter ? `url(#${id}-slot-clip)` : undefined}>
            <g
              key={showPrinter ? `printer-${print}` : 'paper-only'}
              className={showPrinter ? 'usage-receipt-paper' : undefined}
              onAnimationEnd={showPrinter ? () => setPrinting(false) : undefined}
            >
              <path
                d={paperPath}
                fill={`url(#${id}-paper)`}
                stroke={theme.paperStroke}
                strokeWidth="1"
                filter={`url(#${id}-paper-shadow)`}
              />
              {theme.texture !== 'none' && (
                <rect
                  x="32"
                  y={paperTop}
                  width="336"
                  height={bottom - paperTop + 10}
                  fill={`url(#${id}-texture)`}
                  clipPath={`url(#${paperClipId})`}
                />
              )}
              {showPrinter && (
                <rect x="32.5" y={paperTop} width="335" height="16" fill={`url(#${id}-slot-shadow)`} />
              )}

              <g fill={theme.inkPrimary} fontSize="13">
                {/* Top-left Juejin brand mark + SignPainter handwritten vector signature */}
                <g role="img" aria-label="Juejin Usage">
                  <title>Juejin Usage</title>
                  <IconBrandJuejin
                    x={48}
                    y={signatureTop - 4}
                    size={30}
                    stroke={1.75}
                    color={theme.inkAccent}
                    aria-hidden="true"
                  />
                  <g transform={`translate(85 ${signatureTop}) scale(0.95)`}>
                    <path d={SIGNPAINTER_SIGNATURE_PATH} fill={theme.inkAccent} />
                  </g>
                </g>

                {/* Receipt Metadata Key-Value Block */}
                <g fontSize="12">
                  <text x="50" y={metaTop + 12} fill={theme.inkTertiary}>统计周期</text>
                  <text x="350" y={metaTop + 12} textAnchor="end" fontWeight="500" fill={theme.inkSecondary}>{rangeLabel}</text>
                  <text x="50" y={metaTop + 32} fill={theme.inkTertiary}>统计范围</text>
                  <text x="350" y={metaTop + 32} textAnchor="end" fontWeight="500" fill={theme.inkSecondary}>{truncateText(toolLabel, 24)}</text>
                  <text x="50" y={metaTop + 52} fill={theme.inkTertiary}>出单时间</text>
                  <text x="350" y={metaTop + 52} textAnchor="end" fontWeight="400" fill={theme.inkTertiary}>{printedAt}</text>
                </g>

                {/* Itemized Tool Breakdown with Theme-Tinted Monochrome Icons */}
                <path d={`M50 ${tableDividerY}h300`} stroke={theme.inkDivider} strokeDasharray="3 3.5" />
                <g fill={theme.inkMuted} fontSize="11" fontWeight="600">
                  <text x="50" y={tableHeaderY}>工具</text>
                  <text x="262" y={tableHeaderY} textAnchor="end">Token</text>
                  <text x="350" y={tableHeaderY} textAnchor="end">USD</text>
                </g>

                {items.map((tool, index) => (
                  <g key={tool.source ?? `${tool.label}-${index}`} transform={`translate(0 ${tool.y})`}>
                    <title>{tool.label}</title>
                    <g filter={`url(#${iconTintFilterId})`}>
                      <ProviderSvgIcon
                        color="#000000"
                        inkFilterId={inkFilterId}
                        monochrome
                        provider={tool.source ?? tool.label}
                        size={14}
                        x={50}
                        y={-10}
                      />
                    </g>
                    <text x="72" y="1" fontSize="13" fontWeight="500" fill={theme.inkPrimary}>
                      {tool.displayLabel}
                    </text>
                    <g textAnchor="end" fontSize="13">
                      <text x="262" y="1" fontWeight="700" fill={theme.inkPrimary}>{formatTokens(tool.tokens)}</text>
                      <text x="350" y="1" fontWeight="500" fill={theme.inkSecondary}>{usd.format(tool.costUsd)}</text>
                    </g>
                  </g>
                ))}
                {!items.length && (
                  <text x="200" y={tableHeaderY + 28} textAnchor="middle" fontSize="12" fill={theme.inkMuted}>
                    暂无工具明细
                  </text>
                )}

                {/* Token Breakdown Subtotals */}
                <g transform={`translate(0 ${detailTop})`}>
                  <path d="M50 0h300" stroke={theme.inkDivider} strokeDasharray="3 3.5" />
                  {detailRows.map(([label, value], i) => (
                    <g key={label} transform={`translate(0 ${20 + i * 19})`}>
                      <text x="50" fontSize="12" fill={theme.inkTertiary}>{label}</text>
                      <text x="350" textAnchor="end" fontSize="12.5" fontWeight="600" fill={theme.inkSecondary}>
                        {value}
                      </text>
                    </g>
                  ))}
                </g>

                {/* Grand Total Section */}
                <g transform={`translate(0 ${totalTop})`}>
                  <path d="M50 0h300" stroke={theme.inkPrimary} strokeWidth="1.25" strokeDasharray="4 3" />

                  <text x="50" y="24" fontSize="13.5" fontWeight="700" fill={theme.inkPrimary}>总用量</text>
                  <text x="350" y="26" textAnchor="end" fontSize="21" fontWeight="700" fill={theme.inkAccent}>
                    {formatTokens(summary.totalTokens)}
                  </text>
                  <text x="350" y="42" textAnchor="end" fontSize="11.5" fill={theme.inkTertiary}>
                    {summary.totalTokens.toLocaleString('en-US')} Token
                  </text>

                  <text x="50" y="68" fontSize="13.5" fontWeight="700" fill={theme.inkPrimary}>预估费用</text>
                  <text x="350" y="70" textAnchor="end" fontSize="22" fontWeight="700" fill={theme.inkPrimary}>
                    {usd.format(summary.totalCostUsd)}
                  </text>
                  <text x="350" y="86" textAnchor="end" fontSize="11.5" fill={theme.inkSecondary}>
                    ≈ 人民币 {compact.format(summary.totalCostUsd * illustrativeCnyPerUsd)} 元
                  </text>
                  <text x="350" y="102" textAnchor="end" fontSize="10.5" fill={theme.inkMuted}>
                    API 等值估算 · 按 1 USD = {illustrativeCnyPerUsd} CNY 折算
                  </text>
                </g>

                {/* Footer: User Info + Pixel-Style Symmetrical QR Code */}
                <g transform={`translate(0 ${footerTop})`}>
                  <path d="M50 0h300" stroke={theme.inkDivider} strokeDasharray="3 3.5" />

                  <circle cx="71" cy="42" r="19" fill={theme.avatarBg} />
                  <text x="71" y="47" textAnchor="middle" fontSize="14" fontWeight="700" fill={theme.inkPrimary}>
                    {Array.from(name)[0]}
                  </text>
                  {avatarLarge && (
                    <image
                      data-avatar=""
                      href={avatarLarge}
                      x="52"
                      y="23"
                      width="38"
                      height="38"
                      preserveAspectRatio="xMidYMid slice"
                      clipPath={`url(#${id}-avatar)`}
                    />
                  )}
                  <circle cx="71" cy="42" r="19" fill="none" stroke={theme.avatarStroke} strokeWidth="1" />

                  <g clipPath={`url(#${id}-user-info)`}>
                    <title>{`@${name} · ${metaText}`}</title>
                    <text x="102" y="38" fontSize="13.5" fontWeight="700" fill={theme.inkPrimary}>
                      @{truncateText(name, 16)}
                    </text>
                    <text x="102" y="55" fontSize="11.5" fill={theme.inkTertiary}>
                      {truncateText(metaText, 24)}
                    </text>
                  </g>

                  <g transform="translate(284 10)">
                    <StyledShareQrCode
                      ink={theme.inkPrimary}
                      accent={theme.inkAccent}
                      frameInk={theme.inkSecondary}
                      size={66}
                      style="pixel"
                    />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </svg>
      </div>

      {/* Mobile Sticky Bottom Action Bar */}
      <div className="shrink-0 bg-popover px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          {showPrinter && (
            <Button variant="secondary" size="sm" onClick={replay}>
              <IconPrinter aria-hidden="true" />
              重播
            </Button>
          )}
          <Button variant="secondary" size="sm" className="flex-1" disabled={busy} onClick={() => void save('copy')}>
            {doneAction === 'copy' ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}
            {doneAction === 'copy' ? '已复制' : '复制'}
          </Button>
          <Button size="sm" className="flex-1" disabled={busy} onClick={() => void save('download')}>
            {doneAction === 'download' ? <IconCheck aria-hidden="true" /> : <IconDownload aria-hidden="true" />}
            {doneAction === 'download' ? '已保存' : '下载图片'}
          </Button>
        </div>
        {errorStatus && (
          <p className="mt-1.5 text-center text-xs text-destructive">{errorStatus}</p>
        )}
      </div>

      <span role="status" className="sr-only">{liveStatus}</span>
    </div>
  );
}
