import { USAGE_CARD_CATALOG, type UsageCardStyle } from '@juejin-opensource/jusage-core/usage-cards';

export const EMBED_STYLE_OPTIONS = USAGE_CARD_CATALOG;
export type EmbedStyle = UsageCardStyle;
const target = 'https://juejin.cn/aiusage/?from=embed';
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function buildEmbedSnippets(publicApiBase: string, key: string, style: EmbedStyle) {
  if (!EMBED_STYLE_OPTIONS.some(option => option.id === style)) throw new Error('INVALID_EMBED_STYLE');
  const base = new URL(publicApiBase);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_EMBED_API_BASE');
  base.search = ''; base.hash = '';
  const url = `${base.toString().replace(/\/$/, '')}/embed/v1/${encodeURIComponent(key)}/${style}.svg`;
  return {
    url,
    markdown: `[![Juejin AI Usage](${url})](${target})`,
    html: `<a href="${escapeAttribute(target)}"><img src="${escapeAttribute(url)}" alt="Juejin AI Usage" /></a>`,
  };
}
