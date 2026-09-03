/**
 * CLI / Desktop 默认定价覆盖层（打包进产物，启动时对齐写入用户 config.pricing）。
 *
 * 生产客户端启动时拉一次远端价格覆盖层（不轮询）。
 * 完整底表仍内置在 pricing.json。成功拉到的覆盖层会写到
 * `~/.ai-usage/pricing-overlay.json`，下次启动先同步读盘再带超时拉网上。
 * 接口不可用时保留磁盘上一版；没有上一版时使用内置底表。
 */
export const BAKED_PRICING_URL =
  'https://api.juejin.cn/aiusage_api/functions/tud-pricing';
export const BAKED_PRICING_TTL_MS = 60_000;
