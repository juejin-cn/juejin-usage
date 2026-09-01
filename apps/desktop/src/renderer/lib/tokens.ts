/**
 * Domain-level design tokens that sit alongside HeroUI's semantic theme.
 */

export const SOURCE_COLORS: Record<string, string> = {
  claude: 'var(--source-claude)',
  codex: 'var(--source-codex)',
  cursor: 'var(--source-cursor)',
  qoder: 'var(--source-qoder)',
  trae: 'var(--source-trae)',
  gemini: 'var(--source-gemini)',
  opencode: 'var(--source-opencode)',
  copilot: 'var(--source-copilot)',
  antigravity: 'var(--source-antigravity)',
  openclaw: 'var(--source-openclaw)',
  hermes: 'var(--source-hermes)',
  zcode: 'var(--source-zcode)',
  pi: 'var(--source-pi)',
  kimi: 'var(--source-kimi)',
  roocode: 'var(--source-roocode)',
  droid: 'var(--source-droid)',
  kiro: 'var(--source-kiro)',
  cline: 'var(--source-cline)',
  amp: 'var(--source-amp)',
  qwen: 'var(--source-qwen)',
  codebuddy: 'var(--source-codebuddy)',
  workbuddy: 'var(--source-workbuddy)',
  grok: 'var(--source-grok)',
  mimo: 'var(--source-mimo)',
  'every-code': 'var(--source-every-code)',
  omp: 'var(--source-omp)',
  'kilo-cli': 'var(--source-kilo-cli)',
  kilocode: 'var(--source-kilocode)',
  goose: 'var(--source-goose)',
  zed: 'var(--source-zed)',
  warp: 'var(--source-warp)',
  deepseek: 'var(--source-deepseek)',
};

const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  qoder: 'Qoder',
  trae: 'Trae',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  zcode: 'ZCode',
  pi: 'pi',
  kimi: 'Kimi',
  roocode: 'Roo Code',
  droid: 'Droid',
  kiro: 'Kiro',
  cline: 'Cline',
  amp: 'Amp',
  qwen: 'Qwen Code',
  codebuddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  grok: 'Grok Build',
  mimo: 'Mimo',
  'every-code': 'Every Code',
  omp: 'OMP',
  'kilo-cli': 'Kilo CLI',
  kilocode: 'Kilo Code',
  goose: 'Goose',
  zed: 'Zed',
  warp: 'Warp',
  deepseek: 'Deepseek Harness',
};

/** Local `claude` ↔ Server ingest `claude-code` (and similar aliases). */
function canonicalSource(source: string): string {
  const key = source?.toLowerCase?.() ?? '';
  if (key === 'claude-code' || key.startsWith('claude')) return 'claude';
  if (key === 'codex' || key.startsWith('codex')) return 'codex';
  if (key === 'cursor' || key.startsWith('cursor')) return 'cursor';
  if (key === 'qoder' || key.startsWith('qoder')) return 'qoder';
  if (key === 'trae' || key.startsWith('trae')) return 'trae';
  if (key === 'gemini-cli' || key.startsWith('gemini')) return 'gemini';
  if (key === 'open-code' || key.startsWith('opencode')) return 'opencode';
  if (key === 'github-copilot' || key === 'copilot-cli' || key.startsWith('copilot')) {
    return 'copilot';
  }
  if (key.startsWith('antigravity')) return 'antigravity';
  if (key.startsWith('openclaw') || key.startsWith('open-claw')) return 'openclaw';
  if (key.startsWith('hermes')) return 'hermes';
  if (key.startsWith('zcode') || key === 'zai') return 'zcode';
  if (key === 'pi-coding-agent' || key.startsWith('pi')) return 'pi';
  if (key.startsWith('kimi')) return 'kimi';
  if (key === 'roo-code' || key.startsWith('roocode') || key.startsWith('roo')) return 'roocode';
  if (key.startsWith('droid') || key.startsWith('factory')) return 'droid';
  if (key.startsWith('kiro')) return 'kiro';
  if (key.startsWith('cline')) return 'cline';
  if (key.startsWith('amp')) return 'amp';
  if (key === 'qwen-code' || key.startsWith('qwen')) return 'qwen';
  if (key.startsWith('codebuddy') || key === 'code-buddy') return 'codebuddy';
  if (key.startsWith('workbuddy')) return 'workbuddy';
  if (key.startsWith('grok')) return 'grok';
  if (key.startsWith('mimo') || key === 'mimocode' || key.startsWith('xiaomi')) return 'mimo';
  if (key === 'everycode' || key.startsWith('every-code')) return 'every-code';
  if (key.startsWith('omp') || key === 'oh-my-pi') return 'omp';
  if (key.startsWith('kilo-cli') || key === 'kilo') return 'kilo-cli';
  if (key.startsWith('kilocode') || key === 'kilo-code') return 'kilocode';
  if (key.startsWith('goose')) return 'goose';
  if (key.startsWith('zed')) return 'zed';
  if (key.startsWith('warp')) return 'warp';
  if (key.startsWith('deepseek') || key.startsWith('harness') || key.startsWith('dsh')) {
    return 'deepseek';
  }
  return key;
}

/** Returns a CSS color value (typically `var(--source-*)`). */
export function sourceColor(source: string): string {
  return SOURCE_COLORS[canonicalSource(source)] ?? 'var(--muted)';
}

export function sourceLabel(source: string): string {
  const key = canonicalSource(source);
  return SOURCE_LABELS[key] ?? source;
}

export const HEATMAP_STOPS_LIGHT: readonly string[] = [
  'var(--heatmap-0)',
  'var(--heatmap-1)',
  'var(--heatmap-2)',
  'var(--heatmap-3)',
  'var(--heatmap-4)',
] as const;

export const HEATMAP_STOPS_DARK: readonly string[] = HEATMAP_STOPS_LIGHT;

export const TOOLTIP_SHADOW =
  '0 1px 2px rgb(0 0 0 / 0.05), 0 4px 12px rgb(0 0 0 / 0.06)';
