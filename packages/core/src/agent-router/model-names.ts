export function gatewayModelName(_provider: string | undefined, id: string, liveName?: unknown, configuredName?: unknown): string {
  const meaningful = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
    && value.trim() !== id && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
  if (meaningful(liveName)) return liveName.trim();
  if (meaningful(configuredName)) return configuredName.trim();
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(-thinking)?$/i.exec(id);
  if (claude) return `Claude ${claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase()} ${claude[2]}.${claude[3]}${claude[4] ? ' Thinking' : ''}`;
  return id;
}
