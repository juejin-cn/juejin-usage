/**
 * About panel copy — version + supported tool scope.
 * Multi-surface tools list variants in parentheses: `Claude (CLI、Desktop)`.
 */

export const APP_DISPLAY_NAME = 'Juejin Usage';

export type SupportedToolLine = {
  name: string;
  /** Canonical source key for `ProviderIcon`. */
  source: string;
  /** Product surfaces in the same series; shown as `Name (A、B)`. */
  variants?: readonly string[];
};

/** Enabled parsers only; order matches common dashboard source order. */
export const SUPPORTED_TOOLS: readonly SupportedToolLine[] = [
  { name: 'Claude', source: 'claude', variants: ['CLI', 'Desktop'] },
  { name: 'Codex', source: 'codex' },
  { name: 'Cursor', source: 'cursor' },
  {
    name: 'Qoder',
    source: 'qoder',
    variants: ['CLI', 'IDE', 'IDE CN', 'Work'],
  },
  { name: 'Gemini', source: 'gemini', variants: ['CLI'] },
  { name: 'OpenCode', source: 'opencode' },
  { name: 'Copilot', source: 'copilot', variants: ['CLI'] },
  {
    name: 'Antigravity',
    source: 'antigravity',
    variants: ['App', 'IDE', 'CLI'],
  },
  { name: 'OpenClaw', source: 'openclaw' },
  { name: 'Hermes', source: 'hermes' },
  { name: 'ZCode', source: 'zcode' },
  { name: 'DeepSeek Harness', source: 'dsh' },
  { name: 'pi', source: 'pi' },
  { name: 'Kimi', source: 'kimi', variants: ['Code', 'Legacy'] },
  { name: 'Roo Code', source: 'roocode' },
  { name: 'Droid', source: 'droid' },
  { name: 'Kiro', source: 'kiro', variants: ['CLI'] },
  { name: 'Cline', source: 'cline' },
  { name: 'Amp', source: 'amp' },
  { name: 'Qwen Code', source: 'qwen' },
  { name: 'CodeBuddy', source: 'codebuddy' },
  { name: 'WorkBuddy', source: 'workbuddy' },
  { name: 'Grok Build', source: 'grok' },
  { name: 'Mimo', source: 'mimo' },
  { name: 'Every Code', source: 'every-code' },
  { name: 'OMP', source: 'omp' },
  { name: 'Kilo CLI', source: 'kilo-cli' },
  { name: 'Kilo Code', source: 'kilocode' },
  { name: 'Goose', source: 'goose' },
  { name: 'Zed', source: 'zed' },
  { name: 'Warp', source: 'warp' },
] as const;

export function formatSupportedTool(line: SupportedToolLine): string {
  if (!line.variants?.length) return line.name;
  return `${line.name} (${line.variants.join('、')})`;
}

export function appVersion(): string {
  return __APP_VERSION__ || '0.0.0';
}
