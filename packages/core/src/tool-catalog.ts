export type ToolCostStrategy = 'reported-first' | 'estimated';

export interface ToolMetadata {
  key: string;
  displayName: string;
  sortOrder: number;
  costStrategy: ToolCostStrategy;
  costSupported: boolean;
  enabled: boolean;
}

export const TOOL_CATALOG: readonly ToolMetadata[] = [
  {
    key: 'cursor',
    displayName: 'Cursor',
    sortOrder: 10,
    costStrategy: 'reported-first',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'claude-code',
    displayName: 'Claude Code',
    sortOrder: 20,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'codex',
    displayName: 'Codex',
    sortOrder: 25,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'trae',
    displayName: 'Trae',
    sortOrder: 30,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: false,
  },
  {
    key: 'qoder',
    displayName: 'Qoder',
    sortOrder: 40,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'opencode',
    displayName: 'OpenCode',
    sortOrder: 50,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'gemini',
    displayName: 'Gemini CLI',
    sortOrder: 60,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'copilot',
    displayName: 'GitHub Copilot',
    sortOrder: 70,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  {
    key: 'antigravity',
    displayName: 'Antigravity',
    sortOrder: 80,
    costStrategy: 'estimated',
    costSupported: true,
    enabled: true,
  },
  { key: 'openclaw', displayName: 'OpenClaw', sortOrder: 90, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'hermes', displayName: 'Hermes', sortOrder: 100, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'zcode', displayName: 'ZCode', sortOrder: 110, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'dsh', displayName: 'DeepSeek Harness', sortOrder: 115, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'pi', displayName: 'pi', sortOrder: 120, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'kimi', displayName: 'Kimi', sortOrder: 130, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'roocode', displayName: 'Roo Code', sortOrder: 140, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'droid', displayName: 'Droid', sortOrder: 150, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'kiro', displayName: 'Kiro', sortOrder: 160, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'cline', displayName: 'Cline', sortOrder: 170, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'amp', displayName: 'Amp', sortOrder: 180, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'qwen-code', displayName: 'Qwen Code', sortOrder: 190, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'codebuddy', displayName: 'CodeBuddy', sortOrder: 200, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'workbuddy', displayName: 'WorkBuddy', sortOrder: 210, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'grok', displayName: 'Grok Build', sortOrder: 220, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'mimo', displayName: 'Mimo', sortOrder: 230, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'every-code', displayName: 'Every Code', sortOrder: 240, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'omp', displayName: 'OMP', sortOrder: 250, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'kilo-cli', displayName: 'Kilo CLI', sortOrder: 260, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'kilocode', displayName: 'Kilo Code', sortOrder: 270, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'goose', displayName: 'Goose', sortOrder: 280, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'zed', displayName: 'Zed', sortOrder: 290, costStrategy: 'estimated', costSupported: true, enabled: true },
  { key: 'warp', displayName: 'Warp', sortOrder: 300, costStrategy: 'estimated', costSupported: true, enabled: true },
] as const;

export function getEnabledTools(
  catalog: readonly ToolMetadata[] = TOOL_CATALOG,
): ToolMetadata[] {
  return catalog
    .filter((tool) => tool.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

export function findEnabledTool(
  integration: string,
  catalog: readonly ToolMetadata[] = TOOL_CATALOG,
): ToolMetadata | null {
  return catalog.find((tool) => tool.enabled && tool.key === integration) ?? null;
}
